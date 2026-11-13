import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../src/worker/mcp.js";
import { clearLookupCache } from "../src/api/lookup-cache.js";
import type { SkylightProps } from "../src/worker/props.js";

const props: SkylightProps = {
  accessToken: "test-access-1",
  refreshToken: "test-refresh-1",
  fingerprint: "fp",
  expiresAt: Date.now() + 3_600_000,
  frameId: "frame-1",
  timezone: "UTC",
  hasPlus: true,
};

const mealCategories = { data: [{ id: "12", type: "meal_category", attributes: { label: "Dinner" } }] };
const profiles = {
  data: [
    { id: "101", type: "category", attributes: { label: "Alex", linked_to_profile: true } },
    { id: "102", type: "category", attributes: { label: "Sam", linked_to_profile: true } },
    { id: "103", type: "category", attributes: { label: "Soccer", linked_to_profile: false } },
  ],
};
const rel = (ids: string[]) => ({
  meal_category: { data: { type: "meal_category", id: "12" } },
  meal_recipe: { data: null },
  profiles: { data: ids.map((id) => ({ type: "category", id })) },
});

interface Seen {
  method: string;
  url: string;
  version: string | null;
  body: Record<string, unknown> | null;
}
let seen: Seen[] = [];
let existing: unknown[] = [];

function stub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      seen.push({ method, url: u, version: new Headers(init?.headers).get("Skylight-Api-Version"), body });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (u.includes("/meals/categories")) return json(mealCategories);
      if (u.includes("/categories")) return json(profiles);
      if (u.includes("/meals/sittings") && method === "GET") return json({ data: existing, included: profiles.data });
      if (u.includes("/meals/sittings") && method === "POST") {
        return json({ data: [{ id: "900", type: "meal_sitting", attributes: { summary: body?.summary, instances: [body?.date] } }] });
      }
      if (u.includes("/meals/sittings") && method === "PATCH") return json({ data: existing });
      return new Response("not found " + u, { status: 404 });
    })
  );
}

function call(name: string, args: Record<string, unknown>): Request {
  return new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}
async function run(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const json = (await (await handleMcpRequest(call(name, args), props, "t")).json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  return { text: json.result.content.map((c) => c.text).join("\n"), isError: json.result.isError };
}
const writes = (): Seen[] => seen.filter((s) => s.url.includes("/meals/sittings") && s.method !== "GET");

beforeEach(() => {
  seen = [];
  existing = [];
  clearLookupCache();
  stub();
});
afterEach(() => vi.unstubAllGlobals());

describe("create_meal_sitting with profiles", () => {
  it("resolves names to ids, sends the whole form under the app's API version and asks for profiles back", async () => {
    const out = await run("create_meal_sitting", { date: "2026-11-17", mealCategoryId: "12", summary: "Salmon", profiles: ["alex", "Sam"] });
    expect(out.isError).toBeFalsy();
    const [w] = writes();
    expect(writes()).toHaveLength(1);
    expect(w!.version).toBe("2026-10-15");
    expect(new URL(w!.url).searchParams.get("include")).toContain("profiles");
    expect(w!.body).toMatchObject({ date: "2026-11-17", summary: "Salmon", meal_category_id: "12", profile_ids: ["101", "102"], rrule: null });
    expect(out.text).toContain("for Alex, Sam");
  });

  it("an unknown name writes nothing and lists the real names", async () => {
    const out = await run("create_meal_sitting", { date: "2026-11-17", mealCategoryId: "12", summary: "Salmon", profiles: ["Alexander"] });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('No profile called "Alexander"');
    expect(out.text).toContain("Alex, Sam");
    expect(out.text).not.toContain("Soccer"); // a label is not a person
    expect(writes()).toHaveLength(0);
  });

  it("without profiles the request is unchanged: minimal body, default API version", async () => {
    await run("create_meal_sitting", { date: "2026-11-17", mealCategoryId: "12", summary: "Salmon" });
    const [w] = writes();
    expect(w!.version).toBe("2026-03-01");
    expect(w!.body).not.toHaveProperty("profile_ids");
  });

  it("weekly with profiles keeps the rrule and carries the ids", async () => {
    await run("create_meal_sitting", { date: "2026-11-17", mealCategoryId: "12", summary: "Taco night", repeat: "weekly", profiles: ["Sam"] });
    expect(writes()[0]!.body).toMatchObject({ profile_ids: ["102"], rrule: "FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYDAY=TU" });
  });
});

describe("update_meal_sitting with profiles", () => {
  const one = (ids: string[]) => [
    { id: "777", type: "meal_sitting", attributes: { summary: "Salmon", instances: ["2026-11-17"], recurring: false }, relationships: rel(ids) },
  ];

  it("replaces who the meal is for", async () => {
    existing = one(["101"]);
    const out = await run("update_meal_sitting", { sittingId: "777", date: "2026-11-17", profiles: ["Sam"] });
    expect(out.isError).toBeFalsy();
    expect(writes()[0]!.body).toMatchObject({ profile_ids: ["102"], summary: "Salmon" });
    expect(out.text).toContain("now for Sam");
  });

  it("omitting profiles keeps them (a rename must not unassign)", async () => {
    existing = one(["101", "102"]);
    await run("update_meal_sitting", { sittingId: "777", date: "2026-11-17", summary: "Salmon bowls" });
    expect(writes()[0]!.body).toMatchObject({ profile_ids: ["101", "102"], summary: "Salmon bowls" });
  });

  it("an empty list unassigns", async () => {
    existing = one(["101"]);
    const out = await run("update_meal_sitting", { sittingId: "777", date: "2026-11-17", profiles: [] });
    expect(writes()[0]!.body).toMatchObject({ profile_ids: [] });
    expect(out.text).toContain("unassigned");
  });

  it("an unknown name changes nothing", async () => {
    existing = one(["101"]);
    const out = await run("update_meal_sitting", { sittingId: "777", date: "2026-11-17", profiles: ["Nobody"] });
    expect(out.isError).toBe(true);
    expect(writes()).toHaveLength(0);
  });
});

describe("plan_week_meals with profiles", () => {
  const taken = (ids: string[]) => [
    { id: "s1", type: "meal_sitting", attributes: { summary: "Salmon", instances: ["2026-11-17"] }, relationships: rel(ids) },
  ];

  it("adds a second dinner for a different person on the same day", async () => {
    existing = taken(["101"]);
    const out = await run("plan_week_meals", { meals: [{ date: "2026-11-17", summary: "PBJ", profiles: ["Sam"] }] });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.body).toMatchObject({ summary: "PBJ", profile_ids: ["102"] });
    expect(out.text).toContain('added "PBJ" for Sam');
  });

  it("skips when the same person already has that slot", async () => {
    existing = taken(["101"]);
    const out = await run("plan_week_meals", { meals: [{ date: "2026-11-17", summary: "PBJ", profiles: ["Alex", "Sam"] }] });
    expect(writes()).toHaveLength(0);
    expect(out.text).toContain("skipped");
  });

  it("skips when an unassigned meal already fills the slot", async () => {
    existing = taken([]);
    const out = await run("plan_week_meals", { meals: [{ date: "2026-11-17", summary: "PBJ", profiles: ["Sam"] }] });
    expect(writes()).toHaveLength(0);
    expect(out.text).toContain("skipped");
  });

  it("with no profiles the old rule holds: any meal in the slot blocks", async () => {
    existing = taken(["101"]);
    const out = await run("plan_week_meals", { meals: [{ date: "2026-11-17", summary: "PBJ" }] });
    expect(writes()).toHaveLength(0);
    expect(out.text).toContain("skipped");
  });

  it("two planned meals for different people in one call both land", async () => {
    const out = await run("plan_week_meals", {
      meals: [
        { date: "2026-11-18", summary: "Salmon", profiles: ["Alex"] },
        { date: "2026-11-18", summary: "PBJ", profiles: ["Sam"] },
      ],
    });
    expect(writes()).toHaveLength(2);
    expect(out.text).toContain("Wrote 2 of 2");
  });

  it("an unknown profile aborts the whole batch before any write", async () => {
    const out = await run("plan_week_meals", {
      meals: [
        { date: "2026-11-18", summary: "Salmon", profiles: ["Alex"] },
        { date: "2026-11-19", summary: "PBJ", profiles: ["Nobody"] },
      ],
    });
    expect(out.isError).toBe(true);
    expect(writes()).toHaveLength(0);
  });
});
