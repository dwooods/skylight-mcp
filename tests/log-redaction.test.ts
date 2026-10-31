import { afterEach, describe, expect, it, vi } from "vitest";
import { SkylightClient, redactForLog } from "../src/api/client.js";
import type { Config } from "../src/config.js";

// A frame ID that cannot appear by accident anywhere else in a log line.
const FRAME = "7654321";
const config: Config = { frameId: FRAME, authType: "bearer", timezone: "UTC", token: "test-token" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function captureStderr(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
  return lines;
}

describe("the frame ID never reaches the logs", () => {
  it("is redacted from the request log line, but the real URL is still requested", async () => {
    const lines = captureStderr();
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(String(url));
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      })
    );
    await new SkylightClient(config).get("/api/frames/{frameId}/chores", { after: "2026-11-03" });

    expect(requested[0]).toContain(`/frames/${FRAME}/chores`); // redaction is for logs only
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(FRAME);
    expect(lines.join("\n")).toContain("/frames/<frame>/chores");
  });

  it("is redacted from the 401 log line too", async () => {
    const lines = captureStderr();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(new SkylightClient(config).get("/api/frames/{frameId}/chores")).rejects.toThrow();
    for (const line of lines) expect(line).not.toContain(FRAME);
  });

  it("redactForLog only touches the frame segment", () => {
    expect(redactForLog("https://app.ourskylight.com/api/frames/123/meals/sittings?date_min=2026-11-03")).toBe(
      "https://app.ourskylight.com/api/frames/<frame>/meals/sittings?date_min=2026-11-03"
    );
    expect(redactForLog("https://app.ourskylight.com/api/colors")).toBe("https://app.ourskylight.com/api/colors");
  });
});
