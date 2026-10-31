import { describe, expect, it } from "vitest";
import { runDoctor, type DoctorDeps } from "../src/doctor.js";
import type { CredentialStore } from "../src/api/credential-store.js";

function store(has: boolean | Error): CredentialStore {
  return {
    name: "test store",
    read: async () => {
      if (has instanceof Error) throw has;
      return has ? ({ accessToken: "your_token" } as never) : null;
    },
    write: async () => {},
    delete: async () => true,
  } as unknown as CredentialStore;
}

async function run(over: Partial<DoctorDeps>, args: string[] = []): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await runDoctor(args, {
    env: { SKYLIGHT_FRAME_ID: "123456", SKYLIGHT_TIMEZONE: "America/Los_Angeles" },
    nodeVersion: "22.1.0",
    store: store(true),
    checkApi: async () => ({}),
    out: (l) => lines.push(l),
    ...over,
  });
  return { code, text: lines.join("\n") };
}

describe("skylight-mcp doctor", () => {
  it("passes a good setup", async () => {
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.text).toContain("No blocking problems found.");
  });

  it("never prints the frame ID or any token", async () => {
    const r = await run({ env: { SKYLIGHT_FRAME_ID: "9999999", SKYLIGHT_TIMEZONE: "UTC", SKYLIGHT_TOKEN: "your_token" } });
    expect(r.text).not.toContain("9999999");
    expect(r.text).not.toContain("your_token");
  });

  it("fails and says how to fix a missing frame ID and a missing sign-in", async () => {
    const r = await run({ env: {}, store: store(false) });
    expect(r.code).toBe(1);
    expect(r.text).toContain("SKYLIGHT_FRAME_ID is not set");
    expect(r.text).toContain("skylight-mcp auth login");
  });

  it("warns about the silent America/New_York default", async () => {
    const r = await run({ env: { SKYLIGHT_FRAME_ID: "1" } });
    expect(r.code).toBe(0);
    expect(r.text).toContain("defaults to America/New_York");
  });

  it("rejects an invalid timezone", async () => {
    const r = await run({ env: { SKYLIGHT_FRAME_ID: "1", SKYLIGHT_TIMEZONE: "Mars/Olympus" } });
    expect(r.code).toBe(1);
    expect(r.text).toContain("not a valid IANA timezone");
  });

  it("fails closed when the credential store is unusable", async () => {
    const r = await run({ store: store(new Error("Keychain locked")) });
    expect(r.code).toBe(1);
    expect(r.text).toContain("Keychain locked");
    expect(r.text).toContain("fails closed");
  });

  it("reports an API failure without calling it when offline", async () => {
    let called = 0;
    const failing = async () => {
      called++;
      throw new Error("boom");
    };
    const online = await run({ checkApi: failing });
    expect(online.code).toBe(1);
    expect(online.text).toContain("Skylight API check failed: boom");
    const offline = await run({ checkApi: failing }, ["--offline"]);
    expect(offline.code).toBe(0);
    expect(called).toBe(1);
  });

  it("flags a frame timezone that disagrees with the configured one", async () => {
    const r = await run({ checkApi: async () => ({ timezone: "America/Chicago" }) });
    expect(r.text).toContain("Your frame reports timezone America/Chicago");
  });

  it("rejects an old Node", async () => {
    const r = await run({ nodeVersion: "18.19.0" });
    expect(r.code).toBe(1);
    expect(r.text).toContain("too old");
  });
});

// The mocked tests above replace the API check, which is how the real one shipped broken.
// This runs the real check against a stubbed network.
import { afterEach, vi } from "vitest";
import { makeApiCheck } from "../src/doctor.js";
import type { StoredCredential } from "../src/api/oauth.js";

describe("doctor's real API check", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("works without the process-wide client being initialised, and reports the frame timezone", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(String(url));
        const body = String(url).includes("/plus_access") ? {} : { data: { id: "1", type: "frame", attributes: { time_zone: "America/Chicago" } } };
        return new Response(JSON.stringify(body), { status: 200 });
      })
    );
    const credential: StoredCredential = {
      version: 1,
      type: "oauth",
      accessToken: "test-access-1",
      refreshToken: "test-refresh-1",
      fingerprint: "fp",
      expiresAt: Date.now() + 3_600_000,
    };
    const memory = { name: "memory", read: async () => credential, write: async () => {}, delete: async () => true } as unknown as CredentialStore;
    const check = makeApiCheck(memory, { frameId: "frame-1", authType: "bearer", timezone: "UTC" });
    await expect(check()).resolves.toEqual({ timezone: "America/Chicago" });
    expect(seen.some((u) => u.startsWith("https://app.ourskylight.com/api/frames/frame-1"))).toBe(true);
  });
});
