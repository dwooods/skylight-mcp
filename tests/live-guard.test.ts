import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertToolAllowed, DENIED_TOOLS, suiteEnabled } from "./live/harness.js";

// The live suite touches a real family's calendar, so the properties that keep
// it safe are tested in the normal suite, where CI sees them.

const liveDir = path.join(__dirname, "live");
const liveFiles = readdirSync(liveDir).filter((f) => f.endsWith(".live.ts"));

afterEach(() => vi.unstubAllEnvs());

describe("live test guard rails", () => {
  it("suites are off unless SKYLIGHT_LIVE=1", () => {
    vi.stubEnv("SKYLIGHT_LIVE", "");
    expect(suiteEnabled(["read"])).toBe(false);
    vi.stubEnv("SKYLIGHT_LIVE", "true");
    expect(suiteEnabled(["read"])).toBe(false);
    vi.stubEnv("SKYLIGHT_LIVE", "1");
    expect(suiteEnabled(["read"])).toBe(true);
  });

  it("LIVE_TAGS and LIVE_SKIP_TAGS filter suites", () => {
    vi.stubEnv("SKYLIGHT_LIVE", "1");
    vi.stubEnv("LIVE_TAGS", "read");
    expect(suiteEnabled(["read", "contract"])).toBe(true);
    expect(suiteEnabled(["write", "meals"])).toBe(false);
    vi.stubEnv("LIVE_TAGS", "");
    vi.stubEnv("LIVE_SKIP_TAGS", "write");
    expect(suiteEnabled(["write", "meals"])).toBe(false);
    expect(suiteEnabled(["read"])).toBe(true);
  });

  it("message tools are denied by the harness", () => {
    expect([...DENIED_TOOLS].sort()).toEqual(["send_message", "update_message"]);
    expect(() => assertToolAllowed("send_message")).toThrow(/cannot be undone/);
    expect(() => assertToolAllowed("update_message")).toThrow();
    expect(() => assertToolAllowed("get_messages")).not.toThrow();
  });

  it("there is at least one live suite", () => {
    expect(liveFiles.length).toBeGreaterThan(0);
  });

  it.each(liveFiles)("%s is gated through liveSuite and never names a message write", (file) => {
    const source = readFileSync(path.join(liveDir, file), "utf8");
    expect(source).toContain("liveSuite(");
    // An ungated describe/it at top level would run against the frame without opt-in.
    expect(source).not.toMatch(/^\s*(describe|test)\(/m);
    expect(source).not.toMatch(/call\(\s*["'](send_message|update_message)["']/);
  });
});
