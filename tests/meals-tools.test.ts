import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../src/worker/mcp.js";
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

const categories = {
  data: [
    { id: "10", type: "meal_category", attributes: { label: "Breakfast", color: "#fdd" } },
    { id: "12", type: "meal_category", attributes: { label: "Dinner", color: "#ffd" } },
  ],
};

function call(name: string, args: Record<string, unknown>): Request {
  return new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}

async function text(res: Response): Promise<string> {
  const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return json.result.content.map((c) => c.text).join("\n");
}

afterEach(() => vi.unstubAllGlobals());

describe("meal tools against Skylight's real field names", () => {
  it("get_meal_categories shows the label, not Unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(categories), { status: 200 })));
    const out = await text(await handleMcpRequest(call("get_meal_categories", {}), props, "t"));
    expect(out).toContain("Dinner (ID: 12)");
    expect(out).not.toContain("Unknown");
  });

  it("get_meal_sittings shows summary, category name and each instance date in range", async () => {
    const sittings = {
      data: [
        {
          id: "s1",
          type: "meal_sitting",
          attributes: { summary: "Thai green curry", instances: ["2026-11-03", "2026-11-20"] },
          relationships: { meal_category: { data: { type: "meal_category", id: "12" } }, meal_recipe: { data: null } },
        },
        {
          id: "s2",
          type: "meal_sitting",
          attributes: { summary: "", instances: ["2026-11-04"] },
          relationships: { meal_category: { data: { type: "meal_category", id: "12" } }, meal_recipe: { data: { type: "meal_recipe", id: "r9" } } },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(JSON.stringify(String(url).includes("/categories") ? categories : sittings), { status: 200 })
      )
    );
    const out = await text(await handleMcpRequest(call("get_meal_sittings", { date: "2026-11-02", dateEnd: "2026-11-08" }), props, "t"));
    expect(out).toContain("Dinner: Thai green curry");
    expect(out).toContain("recipe r9");
    expect(out).not.toContain("Nov 20"); // out of range instance filtered
  });

  it("create_meal_sitting sends summary as free text and reads the list envelope back", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ data: [{ id: "s77", type: "meal_sitting", attributes: { summary: body.summary, instances: [body.date] } }] }),
          { status: 200 }
        );
      })
    );
    const out = await text(
      await handleMcpRequest(call("create_meal_sitting", { date: "2026-11-03", mealCategoryId: "12", summary: "Sheet-pan fajitas" }), props, "t")
    );
    expect(body).toMatchObject({ date: "2026-11-03", meal_category_id: "12", summary: "Sheet-pan fajitas" });
    expect(body).not.toHaveProperty("meal_recipe_id");
    expect(out).toContain('Scheduled "Sheet-pan fajitas"');
    expect(out).toContain("s77");
  });

  it("create_meal_sitting refuses an empty slot", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleMcpRequest(call("create_meal_sitting", { date: "2026-11-03", mealCategoryId: "12" }), props, "t");
    const json = (await res.json()) as { result: { isError?: boolean } };
    expect(json.result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
