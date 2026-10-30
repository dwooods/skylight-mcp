import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../src/worker/mcp.js";
import type { SkylightProps } from "../src/worker/props.js";
import { attributesOf, resourceList } from "../src/api/endpoints/shape.js";

// Regressions found by the first live run against a real account.

const props: SkylightProps = {
  accessToken: "test-access-1",
  refreshToken: "test-refresh-1",
  fingerprint: "fp",
  expiresAt: Date.now() + 3_600_000,
  frameId: "frame-1",
  timezone: "UTC",
  hasPlus: true,
};

function call(name: string, args: Record<string, unknown>): Request {
  return new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}

async function run(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const res = await handleMcpRequest(call(name, args), props, "t");
  const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: json.result.content.map((c) => c.text).join("\n"), isError: json.result.isError === true };
}

function stub(routes: Array<[RegExp, unknown]>, urls: string[] = []): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    for (const [re, body] of routes) if (re.test(url)) return new Response(JSON.stringify(body), { status: 200 });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }));
}

afterEach(() => vi.unstubAllGlobals());

const dinner = { data: [{ id: "12", type: "meal_category", attributes: { label: "Dinner" } }] };
const sitting = (date: string) => ({
  data: [{ id: "s1", type: "meal_sitting", attributes: { summary: "Soup", instances: [date] }, relationships: { meal_category: { data: { type: "meal_category", id: "12" } }, meal_recipe: { data: null } } }],
});

describe("meal listing includes the end day", () => {
  it("a one-day query asks Skylight for date_max one day later and still shows that day's meal", async () => {
    const urls: string[] = [];
    stub([[/meals\/categories/, dinner], [/meals\/sittings/, sitting("2027-01-13")]], urls);
    const out = await run("get_meal_sittings", { date: "2027-01-13", dateEnd: "2027-01-13" });
    const call = urls.find((u) => u.includes("meals/sittings"))!;
    expect(call).toContain("date_min=2027-01-13");
    expect(call).toContain("date_max=2027-01-14");
    expect(out.text).toContain("Soup");
  });

  it("does not show a meal past the requested end even though the query reaches one day further", async () => {
    stub([[/meals\/categories/, dinner], [/meals\/sittings/, sitting("2027-01-14")]]);
    const out = await run("get_meal_sittings", { date: "2027-01-13", dateEnd: "2027-01-13" });
    expect(out.text).not.toContain("Soup");
  });
});

describe("week overview meal range", () => {
  it("asks for meals one day past the last day shown", async () => {
    const urls: string[] = [];
    stub([[/meals\/categories/, dinner]], urls);
    await run("get_week_overview", { date: "2026-11-02", days: 5 });
    const meals = urls.find((u) => u.includes("meals/sittings"))!;
    expect(meals).toContain("date_min=2026-11-02");
    expect(meals).toContain("date_max=2026-11-07");
  });
});

describe("responses that are not plain JSON:API lists", () => {
  it("get_colors copes with items that have no attributes", async () => {
    stub([[/api\/colors/, { data: [{ id: "c1", type: "color", name: "Teal", hex: "#009" }] }]]);
    const out = await run("get_colors");
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Teal");
  });

  it("get_reward_points copes with a bare array", async () => {
    stub([[/reward_points/, [{ id: "p1", type: "reward_point", attributes: { total: 5 } }]]]);
    const out = await run("get_reward_points");
    expect(out.isError).toBe(false);
    expect(out.text).toContain("total: 5");
  });

  it("an unrecognised shape fails with the top-level keys only, never the values", async () => {
    stub([[/reward_points/, { points: [{ who: "SECRET-NAME" }], total: 3 }]]);
    const out = await run("get_reward_points");
    expect(out.isError).toBe(true);
    expect(out.text).toContain("points, total");
    expect(out.text).not.toContain("SECRET-NAME");
  });

  it("helpers handle the shapes directly", () => {
    expect(resourceList([{ a: 1 }], "x")).toHaveLength(1);
    expect(resourceList({ data: { id: "1" } }, "x")).toHaveLength(1);
    expect(attributesOf({ id: "1", type: "t", name: "n" })).toEqual({ name: "n" });
    expect(attributesOf({ id: "1", attributes: { a: 1 } })).toEqual({ a: 1 });
  });
});
