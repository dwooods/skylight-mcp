import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";
import { HOSTED_DESTRUCTIVE_ALLOWLIST, HOSTED_EFFECTS } from "../src/worker/mcp.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const server = new McpServer({ name: "skylight", version: "t" });
  // Register exactly what the hosted server registers.
  registerTools(server, { hasPlus: true, effects: HOSTED_EFFECTS, include: HOSTED_DESTRUCTIVE_ALLOWLIST, photos: false });
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

function stub(): Array<{ url: string; method: string }> {
  const seen: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    })
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

const cases: Array<[string, Record<string, unknown>]> = [
  ["delete_chore", { choreId: "100" }],
  ["delete_list", { listId: "5" }],
  ["delete_list_item", { listId: "5", itemId: "9" }],
  ["delete_reward", { rewardId: "7" }],
  ["delete_recipe", { recipeId: "3" }],
];

describe("delete_chore on recurring chores", () => {
  it("refuses an occurrence id, with or without confirm, and sends no DELETE", async () => {
    for (const confirm of [false, true]) {
      const seen = stub();
      const text = await call("delete_chore", { choreId: "100-2026-11-03-0600", confirm });
      expect(text).toContain("not supported");
      expect(seen.filter((s) => s.method === "DELETE")).toEqual([]);
    }
  });
});

describe("hosted deletes are gated by confirm", () => {
  it.each(cases)("%s previews and sends no DELETE without confirm", async (name, args) => {
    const seen = stub();
    const text = await call(name, args);
    expect(text).toContain("Preview only");
    expect(seen.filter((s) => s.method === "DELETE")).toEqual([]);
  });

  it.each(cases)("%s sends exactly one DELETE with confirm", async (name, args) => {
    const seen = stub();
    await call(name, { ...args, confirm: true });
    expect(seen.filter((s) => s.method === "DELETE")).toHaveLength(1);
  });
});
