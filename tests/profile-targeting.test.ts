import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { clearCategoriesCache } from "../src/api/endpoints/categories.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

function rpc(name: string, args: Record<string, unknown>): Request {
  return new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}

async function local(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const server = new McpServer({ name: "skylight", version: "t" });
  registerTools(server, { hasPlus: true, photos: false });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(rpc(name, args)));
  const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: json.result.content.map((c) => c.text).join("\n"), isError: json.result.isError === true };
}

const cat = (id: string, label: string) => ({ id, type: "category", attributes: { label, color: "#fff", linked_to_profile: true } });
const categories = { data: [cat("11", "Ben"), cat("12", "Benjamin"), cat("13", "Dave")] };

interface Seen { url: string; method: string; body: Record<string, unknown> | undefined }
function stub(): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      seen.push({ url: String(url), method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const u = String(url);
      const body = u.includes("/categories") ? categories : method === "GET" ? { data: [] } : { data: [{ id: "900", type: "nudge", attributes: {} }] };
      return new Response(JSON.stringify(body), { status: 200 });
    })
  );
  return seen;
}
const writes = (seen: Seen[]) => seen.filter((s) => s.method !== "GET");

afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

describe("profile targeting", () => {
  it("get_family_members prints profile IDs", async () => {
    stub();
    const out = await local("get_family_members", {});
    expect(out.text).toContain("Dave (ID: 13)");
  });

  it("send_message to one profile sets all_profiles false and category_ids", async () => {
    const seen = stub();
    const out = await local("send_message", { body: "Dinner", to: ["dave"], confirm: true });
    const post = writes(seen)[0]!;
    expect(post.url).toBe("https://app.ourskylight.com/api/frames/frame-1/nudges");
    expect(post.body).toMatchObject({ all_profiles: false, category_ids: ["13"], all_devices: true, voice_kind: "silent" });
    expect(out.text).toContain("for Dave");
  });

  it("send_message without `to` still goes to everyone, with no category_ids", async () => {
    const seen = stub();
    await local("send_message", { body: "Hi", confirm: true });
    const post = writes(seen)[0]!;
    expect(post.body).toMatchObject({ all_profiles: true });
    expect(post.body).not.toHaveProperty("category_ids");
  });

  it("preview names the audience and posts nothing", async () => {
    const seen = stub();
    const out = await local("send_message", { body: "Hi", to: ["Ben", "Dave"] });
    expect(out.text).toContain("NOT SENT");
    expect(out.text).toContain("Ben, Dave");
    expect(writes(seen)).toHaveLength(0);
  });

  it("an unknown name fails with the valid list and sends nothing", async () => {
    const seen = stub();
    const out = await local("send_message", { body: "Hi", to: ["Dad"], confirm: true });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("No profile called");
    expect(out.text).toContain("Ben, Benjamin, Dave");
    expect(writes(seen)).toHaveLength(0);
  });

  it("matches the exact name only: Ben never resolves to Benjamin, a prefix resolves to nothing", async () => {
    const seen = stub();
    await local("send_message", { body: "Hi", to: ["Ben"], confirm: true });
    expect(writes(seen)[0]!.body).toMatchObject({ category_ids: ["11"] });
    const bad = await local("send_message", { body: "Hi", to: ["Be"], confirm: true });
    expect(bad.isError).toBe(true);
  });

  it("create_calendar_event resolves profile names to category_ids", async () => {
    const seen = stub();
    await local("create_calendar_event", { summary: "Dentist", startsAt: "2026-11-03T10:00:00", endsAt: "2026-11-03T11:00:00", profiles: ["Ben", "Dave"] });
    expect(writes(seen)[0]!.body).toMatchObject({ category_ids: ["11", "13"] });
  });

  it("an unknown profile on an event writes nothing", async () => {
    const seen = stub();
    const out = await local("create_calendar_event", { summary: "X", startsAt: "2026-11-03T10:00:00", endsAt: "2026-11-03T11:00:00", profiles: ["Nobody"] });
    expect(out.isError).toBe(true);
    expect(writes(seen)).toHaveLength(0);
  });

  it("update_calendar_event reassigns by name and refuses profiles plus categoryIds together", async () => {
    const seen = stub();
    await local("update_calendar_event", { eventId: "5", profiles: ["Dave"] });
    expect(writes(seen)[0]!.body).toMatchObject({ category_ids: ["13"] });
    const both = await local("update_calendar_event", { eventId: "5", profiles: ["Dave"], categoryIds: ["13"] });
    expect(both.isError).toBe(true);
  });
});
