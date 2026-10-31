import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { clearCategoriesCache } from "../src/api/endpoints/categories.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const server = new McpServer({ name: "skylight", version: "t" });
  registerTools(server, { hasPlus: true, photos: false });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const req = new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
  const json = (await res.json()) as { result: { content: Array<{ text: string }> } };
  return json.result.content.map((c) => c.text).join("\n");
}

// Shape copied from a captured routine (placeholder ids and names). A routine is a recurring
// chore with routine: true and a habit_tracker relationship.
const chores = {
  data: [
    {
      id: "c1",
      type: "chore",
      attributes: {
        summary: "Brush teeth",
        status: "pending",
        start: "2026-11-03",
        start_time: null,
        recurring: true,
        recurrence_set: ["RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=6"],
        reward_points: 1,
        routine: true,
        up_for_grabs: false,
      },
      relationships: { category: { data: { type: "category", id: "k1" } }, habit_tracker: { data: { type: "habit_tracker", id: "h1" } } },
    },
    {
      id: "c2",
      type: "chore",
      attributes: { summary: "Feed fish", status: "pending", start: "2026-11-03", start_time: null, recurring: false, routine: false, up_for_grabs: false },
      relationships: { category: { data: { type: "category", id: "k1" } } },
    },
  ],
  included: [{ id: "k1", type: "category", attributes: { label: "Jordan", linked_to_profile: true } }],
};

function stub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/chores")) return new Response(JSON.stringify(chores), { status: 200 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

describe("routines are marked as routines", () => {
  it("get_chores flags a routine and not a plain chore", async () => {
    stub();
    const text = await call("get_chores", { date: "2026-11-03", dateEnd: "2026-11-03" });
    const [routine, plain] = text.split("- ").filter((b) => b.includes("Brush teeth") || b.includes("Feed fish"));
    expect(routine).toContain("Brush teeth");
    expect(routine).toContain("Routine: Yes");
    expect(routine).toContain("BYHOUR=6");
    expect(plain).toContain("Feed fish");
    expect(plain).not.toContain("Routine:");
  });

  it("the week overview tags routines in the day list", async () => {
    stub();
    const text = await call("get_week_overview", { date: "2026-11-03", days: 1 });
    expect(text).toContain("Brush teeth [routine] (Jordan)");
    expect(text).toContain("Feed fish (Jordan)");
    expect(text).not.toContain("Feed fish [routine]");
  });
});
