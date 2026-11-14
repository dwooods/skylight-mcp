/**
 * The properties that matter, with the real library under the canary and only the network
 * replaced: the Skylight token goes to the Skylight host and nowhere else, only reads are made,
 * and the output is a fixed vocabulary with nothing from Skylight and no credential in it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCycle } from "../src/canary/run.js";
import { createSkylight } from "../src/lib.js";
import type { CredentialStore } from "../src/api/credential-store.js";

const TOKEN = "TOKEN-SECRET-123";

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

function stubNetwork(fx: Record<string, unknown>): Call[] {
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
    let body: unknown = { data: [] };
    for (const [suffix, value] of Object.entries(fx)) if (u.pathname.endsWith(suffix)) body = value;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

function deps(log: string[], credential: Parameters<typeof createSkylight>[0]["credential"] = { token: TOKEN }) {
  return {
    skylight: createSkylight({ frameId: "123", timezone: "America/Los_Angeles", credential }),
    timezone: "America/Los_Angeles",
    dinnerName: "Dinner",
    now: () => Date.parse("2037-03-03T16:00:00Z"),
    log: (line: string) => log.push(line),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("canary cycle", () => {
  it("passes: reads only, token only to the Skylight host, one fixed line", async () => {
    const calls = stubNetwork(fixtures());
    const log: string[] = [];
    const result = await runCycle(deps(log));
    expect(result).toEqual({ ok: true, message: "all 5 checks passed" });
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((c) => c.host))).toEqual(new Set(["app.ourskylight.com"]));
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(log).toEqual(["[canary] 2037-03-03 PASS: all 5 checks passed"]);
  });

  it("fails: names the check, and nothing from Skylight is in the output", async () => {
    stubNetwork(fixtures({ "/calendar_events": { data: [] } }));
    const log: string[] = [];
    const result = await runCycle(deps(log));
    expect(result).toMatchObject({ ok: false, message: "FAILED: calendar-week:empty" });
    expect(log.join("\n")).toContain("FAIL: FAILED: calendar-week:empty");
    expect(log.join("\n")).not.toMatch(/Practice|Tacos|League|Alex/);
    expect(log.join("\n")).not.toContain(TOKEN);
  });

  it("a changed shape is a failure, not a silent pass", async () => {
    stubNetwork(fixtures({ "/meals/categories": { data: [{ id: "3", type: "meal_category", attributes: { label: "Lunch" } }] } }));
    const result = await runCycle(deps([]));
    expect(result).toMatchObject({ ok: false, message: "FAILED: meal-categories:no-dinner" });
  });

  it("no stored sign-in: a failure saying so, with no Skylight call and no token", async () => {
    const calls = stubNetwork(fixtures());
    const empty: CredentialStore = { read: async () => null, write: async () => {}, delete: async () => false, readPending: async () => null, writePending: async () => {}, deletePending: async () => false } as unknown as CredentialStore;
    const result = await runCycle(deps([], empty));
    expect(result).toMatchObject({ ok: false, message: "FAILED: sign-in needed" });
    expect(calls).toHaveLength(0);
  });
});
