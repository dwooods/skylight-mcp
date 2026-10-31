import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { clearCategoriesCache } from "../src/api/endpoints/categories.js";
import { isChoreDone } from "../src/api/endpoints/chores.js";
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

// Status values as the live API reports them: a done chore is "complete".
const chore = (id: string, summary: string, status: string) => ({
  id,
  type: "chore",
  attributes: { summary, status, start: "2026-10-30", start_time: "18:00", up_for_grabs: false },
  relationships: { category: { data: { type: "category", id: "k1" } } },
});
const body = {
  data: [chore("1", "Done chore", "complete"), chore("2", "Open chore", "pending")],
  included: [{ id: "k1", type: "category", attributes: { label: "Jordan", linked_to_profile: true } }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

function stub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/categories")) return new Response(JSON.stringify({ data: body.included }), { status: 200 });
      return new Response(JSON.stringify(body), { status: 200 });
    })
  );
}

describe("chore done status", () => {
  it("treats both the live value and the legacy value as done", () => {
    expect(isChoreDone("complete")).toBe(true);
    expect(isChoreDone("completed")).toBe(true);
    expect(isChoreDone("pending")).toBe(false);
    expect(isChoreDone(null)).toBe(false);
  });

  it("get_chores status=completed returns the done chore, pending returns the open one", async () => {
    stub();
    const done = await call("get_chores", { date: "2026-10-30", dateEnd: "2026-10-31", status: "completed" });
    expect(done).toContain("Done chore");
    expect(done).not.toContain("Open chore");
    const open = await call("get_chores", { date: "2026-10-30", dateEnd: "2026-10-31", status: "pending" });
    expect(open).toContain("Open chore");
    expect(open).not.toContain("Done chore");
  });

  it("the week overview marks a done chore [x] on its day", async () => {
    stub();
    const out = await call("get_week_overview", { date: "2026-10-30", days: 2 });
    expect(out).toMatch(/\[x\] Done chore/);
  });

  it("the week overview does not call a done chore overdue, but does flag an open one", async () => {
    stub();
    const out = await call("get_week_overview", { date: "2026-10-31", days: 2 });
    expect(out).not.toContain("Done chore");
    expect(out).toContain("Open chore");
  });
});
