/**
 * The properties that matter, with the real library under the canary and only the network
 * replaced: the Skylight token goes to the Skylight host and nowhere else, the ping host
 * never sees a credential, only reads are made, and the ping address is never logged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCycle } from "../src/canary/run.js";
import { parsePingUrl } from "../src/canary/ping.js";
import { createSkylight } from "../src/lib.js";
import type { CredentialStore } from "../src/api/credential-store.js";

const TOKEN = "TOKEN-SECRET-123";
const UUID = "123e4567-e89b-12d3-a456-426614174000";
const PING = `https://hc-ping.com/${UUID}`;

interface Call {
  host: string;
  path: string;
  method: string;
  auth: string | null;
  body: string | null;
}

const event = { id: "e1", type: "calendar_event", attributes: { summary: "Practice", starts_at: "2037-03-03T16:00:00.000-08:00", ends_at: "2037-03-03T17:00:00.000-08:00", all_day: false, source: "google", editable: true, recurring: false }, relationships: { categories: { data: [{ id: "11" }] } } };

function fixtures(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "/calendar_events": { data: [event] },
    "/categories": { data: [{ id: "11", type: "category", attributes: { label: "Alex", color: "#fff", linked_to_profile: true } }] },
    "/source_calendars": { data: [{ id: "2", type: "source_calendar", attributes: { label: "League", kind: "webcal", role: "reader", editable: false } }] },
    "/meals/sittings": { data: [{ id: "5", type: "meal_sitting", attributes: { summary: "Tacos", instances: ["2037-03-03"], recurring: false }, relationships: { meal_category: { data: { id: "3", type: "x" } } } }] },
    "/meals/categories": { data: [{ id: "3", type: "meal_category", attributes: { label: "Dinner" } }] },
    ...over,
  };
}

function stubNetwork(fx: Record<string, unknown>, pingStatus = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({
      host: u.host,
      path: u.pathname,
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (u.host === "hc-ping.com") return new Response("OK", { status: pingStatus });
    let body: unknown = { data: [] };
    for (const [suffix, value] of Object.entries(fx)) if (u.pathname.endsWith(suffix)) body = value;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

function deps(log: string[], credential: Parameters<typeof createSkylight>[0]["credential"] = { token: TOKEN }) {
  return {
    skylight: createSkylight({ frameId: "123", timezone: "America/Los_Angeles", credential }),
    pingUrl: parsePingUrl(PING),
    timezone: "America/Los_Angeles",
    dinnerName: "Dinner",
    now: () => Date.parse("2037-03-03T16:00:00Z"),
    log: (line: string) => log.push(line),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("canary cycle", () => {
  it("passes: reads only, token only to the Skylight host, one pass ping with no credential", async () => {
    const calls = stubNetwork(fixtures());
    const log: string[] = [];
    const result = await runCycle(deps(log));
    expect(result).toMatchObject({ ok: true, pinged: true });

    const skylight = calls.filter((c) => c.host !== "hc-ping.com");
    expect(skylight.length).toBeGreaterThan(0);
    expect(new Set(skylight.map((c) => c.host))).toEqual(new Set(["app.ourskylight.com"]));
    expect(skylight.every((c) => c.method === "GET")).toBe(true);
    expect(skylight.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);

    const pings = calls.filter((c) => c.host === "hc-ping.com");
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({ path: `/${UUID}`, method: "POST", auth: null, body: "all 5 checks passed" });
    expect(JSON.stringify(pings)).not.toContain(TOKEN);
  });

  it("fails: a /fail ping naming the check, and nothing from Skylight in it", async () => {
    const calls = stubNetwork(fixtures({ "/calendar_events": { data: [] } }));
    const log: string[] = [];
    const result = await runCycle(deps(log));
    expect(result).toMatchObject({ ok: false, message: "FAILED: calendar-week:empty" });
    const ping = calls.find((c) => c.host === "hc-ping.com")!;
    expect(ping.path).toBe(`/${UUID}/fail`);
    expect(ping.body).toBe("FAILED: calendar-week:empty");
    expect(ping.body).not.toMatch(/Practice|Tacos|League|Alex/);
  });

  it("a changed shape is a failure, not a silent pass", async () => {
    stubNetwork(fixtures({ "/meals/categories": { data: [{ id: "3", type: "meal_category", attributes: { label: "Lunch" } }] } }));
    const result = await runCycle(deps([]));
    expect(result).toMatchObject({ ok: false, message: "FAILED: meal-categories:no-dinner" });
  });

  it("no stored sign-in: one /fail ping saying so, and no token anywhere", async () => {
    const calls = stubNetwork(fixtures());
    const empty: CredentialStore = { read: async () => null, write: async () => {}, delete: async () => false, readPending: async () => null, writePending: async () => {}, deletePending: async () => false } as unknown as CredentialStore;
    const result = await runCycle(deps([], empty));
    expect(result).toMatchObject({ ok: false, message: "FAILED: sign-in needed" });
    expect(calls.filter((c) => c.host !== "hc-ping.com")).toHaveLength(0);
    expect(calls.find((c) => c.host === "hc-ping.com")?.path).toBe(`/${UUID}/fail`);
  });

  it("never logs the ping address, and reports an unsent ping", async () => {
    stubNetwork(fixtures(), 500);
    const log: string[] = [];
    const result = await runCycle({ ...deps(log), fetchImpl: async () => new Response("no", { status: 500 }) });
    expect(result.pinged).toBe(false);
    const text = log.join("\n");
    expect(text).toContain("NOT sent");
    expect(text).not.toContain(UUID);
    expect(text).not.toContain("hc-ping.com/");
    expect(text).not.toContain(TOKEN);
  });
});
