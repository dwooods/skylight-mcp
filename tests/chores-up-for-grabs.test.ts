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

const chores = {
  data: [
    { id: "c1", type: "chore", attributes: { summary: "Wipe counters", status: "pending", start: "2026-11-03", start_time: null }, relationships: { category: { data: null } } },
    { id: "c2", type: "chore", attributes: { summary: "Feed fish", status: "pending", start: "2026-11-03", start_time: null }, relationships: { category: { data: { type: "category", id: "k1" } } } },
  ],
  included: [{ id: "k1", type: "category", attributes: { label: "Jordan", linked_to_profile: true } }],
};

function stub(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/chores")) return new Response(JSON.stringify(chores), { status: 200 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    })
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

describe("Up for Grabs chores", () => {
  it("get_chores asks Skylight for them and labels unassigned chores", async () => {
    const urls = stub();
    const text = await call("get_chores", { date: "2026-11-03", dateEnd: "2026-11-03" });
    expect(urls.find((u) => u.includes("/chores"))).toContain("include_up_for_grabs=true");
    expect(text).toContain("Wipe counters");
    expect(text).toContain("up for grabs");
    expect(text).toContain("Assigned to: Jordan");
  });

  it("the week overview asks for them too and labels them", async () => {
    const urls = stub();
    const text = await call("get_week_overview", { date: "2026-11-03", days: 1 });
    expect(urls.find((u) => u.includes("/chores"))).toContain("include_up_for_grabs=true");
    expect(text).toContain("Wipe counters (up for grabs)");
    expect(text).toContain("Feed fish (Jordan)");
  });
});
