import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { clearCategoriesCache } from "../src/api/endpoints/categories.js";
import { buildWeeklyRule } from "../src/api/endpoints/chores.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
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
  const json = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { text: json.result.content.map((c) => c.text).join("\n"), isError: !!json.result.isError };
}

interface Seen { url: string; method: string; body: unknown }

function stub(): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      seen.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "DELETE") return new Response(null, { status: 200 });
      if (method === "PUT") {
        return new Response(
          JSON.stringify({ data: { id: "200", type: "chore", attributes: { summary: "Renamed", recurrence_set: ["RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYHOUR=20;BYDAY=MO,TU,WE,SA"] } } }),
          { status: 200 }
        );
      }
      if (u.includes("create_multiple")) {
        return new Response(JSON.stringify({ data: [{ id: "300", type: "chore", attributes: { summary: "Brush teeth" } }] }), { status: 200 });
      }
      if (u.includes("/categories")) {
        return new Response(JSON.stringify({ data: [{ id: "7", type: "category", attributes: { label: "Jordan", linked_to_profile: true } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    })
  );
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCategoriesCache();
});

const OCC = "100-2026-11-03-0600";
const writes = (seen: Seen[]) => seen.filter((s) => s.method !== "GET");

describe("buildWeeklyRule", () => {
  it("matches the app's captured rules", () => {
    expect(buildWeeklyRule(["WE", "SA", "SU"], "afternoon")).toBe("RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYHOUR=14;BYDAY=WE,SA,SU");
    expect(buildWeeklyRule(["SA", "WE", "TU", "MO"], "evening")).toBe("RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYHOUR=20;BYDAY=MO,TU,WE,SA");
    expect(buildWeeklyRule(["MO"], "morning")).toContain("BYHOUR=6;");
  });
});

describe("delete_chore on recurring chores", () => {
  it("refuses with no scope and sends nothing", async () => {
    const seen = stub();
    const r = await call("delete_chore", { choreId: OCC, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("scope");
    expect(writes(seen)).toEqual([]);
  });

  it("previews with a scope and sends nothing", async () => {
    const seen = stub();
    const r = await call("delete_chore", { choreId: OCC, scope: "all" });
    expect(r.text).toContain("Preview only");
    expect(writes(seen)).toEqual([]);
  });

  it.each(["future", "all"])("with confirm sends DELETE ?apply_to=%s to the occurrence id", async (scope) => {
    const seen = stub();
    await call("delete_chore", { choreId: OCC, scope, confirm: true });
    const del = writes(seen);
    expect(del).toHaveLength(1);
    expect(del[0].method).toBe("DELETE");
    expect(del[0].url).toContain(`/frames/frame-1/chores/${OCC}`);
    expect(new URL(del[0].url).searchParams.get("apply_to")).toBe(scope);
  });

  it("refuses a scope on a one-off chore", async () => {
    const seen = stub();
    const r = await call("delete_chore", { choreId: "555", scope: "all", confirm: true });
    expect(r.isError).toBe(true);
    expect(writes(seen)).toEqual([]);
  });
});

describe("update_chore on recurring chores", () => {
  it("rename sends a flat body to the occurrence id and reports the new id", async () => {
    const seen = stub();
    const r = await call("update_chore", { choreId: OCC, summary: "Renamed" });
    const put = writes(seen)[0];
    expect(put.method).toBe("PUT");
    expect(put.url).toContain(`/chores/${OCC}`);
    expect(put.body).toEqual({ summary: "Renamed" });
    expect(r.text).toContain("series id is now 200");
  });

  it("refuses a schedule change without acknowledgeReset", async () => {
    const seen = stub();
    const r = await call("update_chore", { choreId: OCC, days: ["MO"], timeOfDay: "evening" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("acknowledgeReset");
    expect(writes(seen)).toEqual([]);
  });

  it("with acknowledgeReset sends only recurrence_set", async () => {
    const seen = stub();
    await call("update_chore", { choreId: OCC, days: ["SA", "MO", "TU", "WE"], timeOfDay: "evening", acknowledgeReset: true });
    expect(writes(seen)[0].body).toEqual({ recurrence_set: ["RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYHOUR=20;BYDAY=MO,TU,WE,SA"] });
  });

  it("refuses fields that were never captured, and half a schedule", async () => {
    const seen = stub();
    for (const args of [{ date: "2026-11-05" }, { assignee: "Jordan" }, { rewardPoints: 3 }, { days: ["MO"] }, { timeOfDay: "morning" }]) {
      const r = await call("update_chore", { choreId: OCC, ...args });
      expect(r.isError).toBe(true);
    }
    expect(writes(seen)).toEqual([]);
  });
});

describe("create_routine", () => {
  it("posts the captured create_multiple shape", async () => {
    const seen = stub();
    const r = await call("create_routine", { summary: "Brush teeth", profiles: ["Jordan"], days: ["WE", "SA", "SU"], timeOfDay: "afternoon", startDate: "2026-11-03" });
    const post = writes(seen)[0];
    expect(post.method).toBe("POST");
    expect(post.url).toContain("/frames/frame-1/chores/create_multiple");
    expect(post.body).toEqual({
      summary: "Brush teeth",
      start: "2026-11-03",
      category_ids: ["7"],
      routine: true,
      track_habit: false,
      up_for_grabs: false,
      emoji_icon: null,
      reward_points: null,
      recurrence_set: ["RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYHOUR=14;BYDAY=WE,SA,SU"],
      recurring_until: null,
      renewal_interval: null,
      renewal_unit: null,
      start_time: null,
    });
    expect(r.text).toContain("300");
  });
});
