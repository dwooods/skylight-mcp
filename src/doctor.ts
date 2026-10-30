/**
 * `skylight-mcp doctor`: checks the things that go wrong on first setup and
 * says what to fix. CLI only. It never prints a token, the frame ID or any
 * account data; it reports "set" / "not set" and pass/fail.
 */

import { defaultCredentialStore, type CredentialStore } from "./api/credential-store.js";
import { getFrame } from "./api/endpoints/frames.js";

export type Level = "ok" | "warn" | "fail";

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  store: CredentialStore;
  /** Calls Skylight once. Returns the frame's own timezone when it reports one. */
  checkApi: () => Promise<{ timezone?: string }>;
  out: (line: string) => void;
}

function defaultDeps(): DoctorDeps {
  return {
    env: process.env,
    nodeVersion: process.versions.node,
    store: defaultCredentialStore(),
    checkApi: async () => {
      const frame = await getFrame();
      const attrs = frame.attributes as Record<string, unknown>;
      const tz = attrs.time_zone ?? attrs.timezone;
      return { timezone: typeof tz === "string" ? tz : undefined };
    },
    out: (line) => console.log(line),
  };
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(args: readonly string[], overrides: Partial<DoctorDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  const offline = args.includes("--offline");
  const results: Array<{ level: Level; text: string }> = [];
  const add = (level: Level, text: string): void => {
    results.push({ level, text });
  };

  const major = Number(deps.nodeVersion.split(".")[0]);
  if (major >= 20) add("ok", `Node ${deps.nodeVersion}`);
  else add("fail", `Node ${deps.nodeVersion} is too old. Install Node 20 or newer.`);

  const frame = deps.env.SKYLIGHT_FRAME_ID?.trim();
  if (!frame) {
    add("fail", "SKYLIGHT_FRAME_ID is not set. It is the number in https://ourskylight.com/my-skylight/<number> after you sign in.");
  } else if (!/^\d+$/.test(frame)) {
    add("warn", "SKYLIGHT_FRAME_ID is set but is not all digits. Check you copied the number from the my-skylight URL.");
  } else {
    add("ok", "SKYLIGHT_FRAME_ID is set");
  }

  const tz = deps.env.SKYLIGHT_TIMEZONE?.trim();
  if (!tz) {
    add("warn", "SKYLIGHT_TIMEZONE is not set, so it defaults to America/New_York. Event times and date windows are wrong if your household is elsewhere. Set it, e.g. America/Los_Angeles.");
  } else if (!validTimeZone(tz)) {
    add("fail", `SKYLIGHT_TIMEZONE "${tz}" is not a valid IANA timezone (example: America/Chicago).`);
  } else {
    add("ok", `SKYLIGHT_TIMEZONE is ${tz}`);
  }

  let haveAuth = false;
  if (deps.env.SKYLIGHT_TOKEN) {
    haveAuth = true;
    add("warn", "Using SKYLIGHT_TOKEN from the environment. A stored sign-in (skylight-mcp auth login) is safer and refreshes itself.");
  } else {
    try {
      const credential = await deps.store.read();
      if (credential) {
        haveAuth = true;
        add("ok", `Signed in (${deps.store.name})`);
      } else {
        add("fail", "Not signed in. Run: skylight-mcp auth login");
      }
    } catch (error) {
      add("fail", `Credential store unusable: ${error instanceof Error ? error.message : "unknown error"}. It fails closed; nothing falls back to plaintext.`);
    }
  }

  if (offline) {
    add("warn", "Skipped the Skylight API check (--offline).");
  } else if (!frame || !haveAuth) {
    add("warn", "Skipped the Skylight API check until the items above are fixed.");
  } else {
    try {
      const info = await deps.checkApi();
      add("ok", "Skylight API answered for your frame");
      if (info.timezone && tz && info.timezone !== tz) {
        add("warn", `Your frame reports timezone ${info.timezone} but SKYLIGHT_TIMEZONE is ${tz}.`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown error";
      add("fail", `Skylight API check failed: ${msg}. This API is unofficial and can change; if you are signed in and the frame ID is right, check the project issues.`);
    }
  }

  const mark = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]" } as const;
  for (const r of results) deps.out(`${mark[r.level]} ${r.text}`);
  const failed = results.filter((r) => r.level === "fail").length;
  deps.out(failed === 0 ? "\nNo blocking problems found." : `\n${failed} problem${failed === 1 ? "" : "s"} to fix.`);
  return failed === 0 ? 0 : 1;
}
