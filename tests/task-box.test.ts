import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

async function call(name: string): Promise<{ text: string; isError: boolean }> {
  const server = new McpServer({ name: "skylight", version: "t" });
  registerTools(server, { hasPlus: true, photos: false });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const req = new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
  });
  const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
  const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: json.result.content.map((c) => c.text).join("\n"), isError: json.result.isError === true };
}

// Shape captured from the web app's GET /task_box/items; ids and names are placeholders.
const item = (id: string, summary: string, routine: boolean, emoji: string | null = null, points: number | null = null) => ({
  id,
  type: "task_box_item",
  attributes: { id: Number(id), summary, emoji_icon: emoji, routine, reward_points: points },
});

function stub(body: unknown): Array<{ url: string; method: string }> {
  const seen: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      seen.push({ url: String(url), method: init.method ?? "GET" });
      return new Response(JSON.stringify(body), { status: 200 });
    })
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("get_task_box", () => {
  it("lists chores and routines separately, with emoji and points", async () => {
    stub({ data: [item("1", "Vacuum", false), item("2", "Brush teeth", true, "🪥"), item("3", "Take out trash", false, null, 5)] });
    const out = await call("get_task_box");
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Task box: 3 items");
    expect(out.text).toMatch(/Chores:[\s\S]*- Vacuum[\s\S]*- Take out trash \(5 points\)[\s\S]*Routines:[\s\S]*- 🪥 Brush teeth/);
    expect(out.text).not.toMatch(/Chores:[\s\S]*Brush teeth[\s\S]*Routines:/);
  });

  it("makes exactly one GET to the task box items path and writes nothing", async () => {
    const seen = stub({ data: [item("1", "Vacuum", false)] });
    await call("get_task_box");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toContain("/api/frames/frame-1/task_box/items");
    expect(seen[0]!.url.startsWith("https://app.ourskylight.com/")).toBe(true);
  });

  it("says so when the task box is empty", async () => {
    stub({ data: [] });
    expect((await call("get_task_box")).text).toBe("The task box is empty.");
  });

  it("never reports 'empty' for a shape it does not recognise, and prints keys only", async () => {
    stub({ items: [{ summary: "Private chore name" }], meta: {} });
    const out = await call("get_task_box");
    expect(out.isError).toBe(true);
    expect(out.text).toContain("items, meta");
    expect(out.text).not.toContain("Private chore name");
  });
});
