import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { clearCategoriesCache } from "../src/api/endpoints/categories.js";
import { parseOccurrenceId } from "../src/api/endpoints/chores.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";
import { HOSTED_EFFECTS, HOSTED_DESTRUCTIVE_ALLOWLIST } from "../src/worker/mcp.js";

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
      seen.push({ url: u, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u.includes("/completions")) {
        return new Response(
          JSON.stringify({
            data: { id: "100", type: "chore", attributes: { summary: "Brush teeth", status: "complete" } },
            meta: { reward_points: { category_id: 1, lifetime_points_earned: 5, current_point_balance: 5 } },
            included: [{ type: "habit_tracker", id: "9", attributes: { current_streak: 1, longest_streak: 1 } }],
          }),
          { status: 200 }
        );
      }
      if (u.includes("/reward_points")) {
        return new Response(JSON.stringify([{ category_id: 1, lifetime_points_earned: 12, current_point_balance: 7 }]), { status: 200 });
      }
      if (u.includes("/categories")) {
        return new Response(JSON.stringify({ data: [{ id: "1", type: "category", attributes: { label: "Jordan", linked_to_profile: true } }] }), { status: 200 });
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

describe("parseOccurrenceId", () => {
  it("splits an occurrence id and rejects anything else", () => {
    expect(parseOccurrenceId("100-2026-11-03-0600")).toEqual({ seriesId: "100", instanceDate: "2026-11-03", instanceTime: "06:00" });
    for (const bad of ["100", "abc-2026-11-03-0600", "100-2026-11-03", "../100-2026-11-03-0600", "100-2026-11-03-0600/x"]) {
      expect(parseOccurrenceId(bad)).toBeNull();
    }
  });
});

describe("complete_chore", () => {
  it("previews by default and sends nothing", async () => {
    const seen = stub();
    const r = await call("complete_chore", { choreId: "100-2026-11-03-0600" });
    expect(r.text).toContain("Preview only");
    expect(seen.filter((s) => s.method !== "GET")).toEqual([]);
  });

  it("with confirm, PUTs to the series id with the occurrence in the body", async () => {
    const seen = stub();
    const r = await call("complete_chore", { choreId: "100-2026-11-03-0600", confirm: true });
    const put = seen.find((s) => s.url.includes("/completions"))!;
    expect(put.method).toBe("PUT");
    expect(put.url).toContain("/frames/frame-1/chores/100/completions");
    expect(put.body).toMatchObject({ status: "complete", instance_date: "2026-11-03", instance_time: "06:00" });
    expect(r.text).toContain("Points balance: 5");
    expect(r.text).toContain("Streak: 1 (longest 1)");
  });

  it("complete: false sends pending without completed_on", async () => {
    const seen = stub();
    await call("complete_chore", { choreId: "100-2026-11-03-0600", complete: false, confirm: true });
    const put = seen.find((s) => s.url.includes("/completions"))!;
    expect(put.body).toEqual({ status: "pending", instance_date: "2026-11-03", instance_time: "06:00" });
  });

  it("refuses ids it cannot parse, even with confirm, and sends nothing", async () => {
    const seen = stub();
    const r = await call("complete_chore", { choreId: "100", confirm: true });
    expect(r.isError).toBe(true);
    expect(seen.filter((s) => s.method !== "GET")).toEqual([]);
  });

  it("is available on the hosted profile too", () => {
    const server = new McpServer({ name: "t", version: "0" });
    const registered = registerTools(server, { hasPlus: true, effects: HOSTED_EFFECTS, include: HOSTED_DESTRUCTIVE_ALLOWLIST, photos: false });
    expect(registered).toContain("complete_chore");
  });
});

describe("update_chore", () => {
  it("refuses a completion status and points to complete_chore, sending nothing", async () => {
    const seen = stub();
    for (const status of ["completed", "pending"]) {
      const r = await call("update_chore", { choreId: "100", status });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("complete_chore");
    }
    expect(seen.filter((s) => s.method !== "GET")).toEqual([]);
  });
});

describe("get_reward_points", () => {
  it("shows profile names and balances, not ids", async () => {
    stub();
    const r = await call("get_reward_points", {});
    expect(r.text).toContain("Jordan");
    expect(r.text).toContain("Current balance: 7");
    expect(r.text).toContain("Lifetime earned: 12");
    expect(r.text).not.toContain("undefined");
  });
});
