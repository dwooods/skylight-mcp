import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { clearCategoriesCache } from "../src/api/endpoints/categories.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";
import { HOSTED_DESTRUCTIVE_ALLOWLIST, HOSTED_EFFECTS } from "../src/worker/mcp.js";

const config = { frameId: "frame-1", timezone: "America/Los_Angeles", token: "test-access-1", authType: "bearer" as const };

async function call(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const server = new McpServer({ name: "skylight", version: "t" });
  registerTools(server, { hasPlus: true, effects: HOSTED_EFFECTS, include: HOSTED_DESTRUCTIVE_ALLOWLIST, photos: false });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const req = new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_calendar_event", arguments: args } }),
  });
  const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
  const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: json.result.content.map((c) => c.text).join("\n"), isError: Boolean(json.result.isError) };
}

type Post = { url: string; body: Record<string, unknown> };
function stub() {
  const posts: Post[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/categories")) {
        const cat = (id: string, label: string) => ({ id, type: "category", attributes: { label, linked_to_profile: true } });
        return new Response(JSON.stringify({ data: [cat("11", "Alex"), cat("13", "Jordan")] }), { status: 200 });
      }
      if ((init?.method ?? "GET") === "POST" && u.includes("/calendar_events")) {
        posts.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        return new Response(JSON.stringify({ data: { id: "99-1900000000", type: "calendar_event", attributes: {} } }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    })
  );
  return { posts };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

const base = { summary: "Practice", startsAt: "2037-03-03T16:00", endsAt: "2037-03-03T17:00", repeat: { frequency: "weekly", count: 3 } };

// The free-tier "Dinner plan", captured from the Skylight web app on a free account (2026-11-10, 200).
const CAPTURED = {
  summary: "Burgers",
  kind: "meal",
  starts_at: "2026-11-10",
  ends_at: "2026-11-11",
  all_day: true,
  timezone: "America/Los_Angeles",
  description: "Burgers tonight",
  location: "",
  category_ids: [],
  rrule: null,
  countdown_enabled: false,
};

describe("create_calendar_event with dinner: true (free-tier Dinner plan)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearCategoriesCache();
  });

  it("sends the captured shape: all-day, kind meal, dates only, no profiles or calendar", async () => {
    const s = stub();
    const r = await call({ summary: "Burgers", startsAt: "2026-11-10", description: "Burgers tonight", dinner: true });
    expect(r.isError).toBe(false);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.body).toEqual(CAPTURED);
    expect(r.text).toContain("dinner plan");
  });

  it("accepts endsAt only when it is the next day", async () => {
    const s = stub();
    expect((await call({ summary: "Burgers", startsAt: "2026-11-10", endsAt: "2026-11-11", dinner: true })).isError).toBe(false);
    const wrong = await call({ summary: "Burgers", startsAt: "2026-11-10", endsAt: "2026-11-12", dinner: true });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("2026-11-11");
    expect(s.posts).toHaveLength(1);
  });

  it.each([
    ["profiles", { profiles: ["Alex"] }],
    ["calendar", { calendar: "Family" }],
    ["repeat", { repeat: { frequency: "weekly", count: 2 } }],
    ["location", { location: "Home" }],
    ["confirm", { confirm: true }],
    ["a time instead of a date", { startsAt: "2026-11-10T18:00:00" }],
  ])("refuses %s on a dinner plan, sending nothing", async (_name, extra) => {
    const s = stub();
    const r = await call({ summary: "Burgers", startsAt: "2026-11-10", dinner: true, ...extra });
    expect(r.isError).toBe(true);
    expect(s.posts).toEqual([]);
  });

  it("an ordinary event still needs endsAt and is still kind standard", async () => {
    const s = stub();
    const missing = await call({ summary: "Dentist", startsAt: "2026-11-10T09:00:00" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("endsAt");
    await call({ summary: "Dentist", startsAt: "2026-11-10T09:00:00", endsAt: "2026-11-10T10:00:00" });
    expect(s.posts[0]!.body.kind).toBe("standard");
  });
});
