import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../src/worker/mcp.js";
import type { SkylightProps } from "../src/worker/props.js";
import { isoWithOffset } from "../src/api/endpoints/messages.js";

const props: SkylightProps = {
  accessToken: "test-access-1",
  refreshToken: "test-refresh-1",
  fingerprint: "fp",
  expiresAt: Date.now() + 3_600_000,
  frameId: "frame-1",
  timezone: "America/Los_Angeles",
  hasPlus: true,
};

const SIGNED = "https://bucket.example.com/a.mp3?X-Amz-Security-Token=SECRETTOKEN&X-Amz-Signature=SECRETSIG";
const nudges = {
  data: [
    { id: "n2", type: "nudge", attributes: { body: "Dinner at 6", deliver_at: "2026-10-30T00:03:48.239Z", all_profiles: false, all_devices: true, audio_url: SIGNED }, relationships: { categories: { data: [{ type: "category", id: "k1" }] }, sender_category: { data: { type: "category", id: "k2" } }, devices: { data: [] } } },
    { id: "n1", type: "nudge", attributes: { body: "Have a great day", deliver_at: "2026-10-30T00:01:22.763Z", all_profiles: true, all_devices: false, recurring: true, audio_url: SIGNED }, relationships: { categories: { data: [] }, sender_category: { data: null }, devices: { data: [{ type: "device", id: "d1" }] } } },
  ],
};
const categories = { data: [{ id: "k1", type: "category", attributes: { label: "Ben" } }, { id: "k2", type: "category", attributes: { label: "Dad" } }] };

function call(args: Record<string, unknown>): Request {
  return new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_messages", arguments: args } }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("isoWithOffset", () => {
  it("formats with the zone offset, across DST", () => {
    expect(isoWithOffset(Date.parse("2026-10-01T07:00:00.000Z"), "America/Los_Angeles")).toBe("2026-10-01T00:00:00.000-07:00");
    expect(isoWithOffset(Date.parse("2026-11-15T08:00:00.000Z"), "America/Los_Angeles")).toBe("2026-11-15T00:00:00.000-08:00");
  });
});

describe("get_messages", () => {
  it("queries the pinned nudges endpoint with an offset-bearing range and never surfaces audio URLs", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(String(u));
      const body = String(u).includes("/nudges") ? nudges : String(u).includes("/categories") ? categories : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const res = await handleMcpRequest(call({ date: "2026-10-29", dateEnd: "2026-10-29" }), props, "t");
    const out = ((await res.json()) as { result: { content: Array<{ text: string }> } }).result.content[0].text;

    const nudgeUrl = urls.find((u) => u.includes("/nudges"))!;
    expect(nudgeUrl.startsWith("https://app.ourskylight.com/api/frames/frame-1/nudges?")).toBe(true);
    expect(decodeURIComponent(nudgeUrl)).toContain("after=2026-10-29T00:00:00.000-07:00");
    expect(decodeURIComponent(nudgeUrl)).toContain("before=2026-10-29T23:59:59.999-07:00");

    expect(out).toContain('5:01 PM: "Have a great day" (to everyone, recurring, selected devices) [message ID: n1]');
    expect(out).toContain('5:03 PM: "Dinner at 6" (to Ben, from Dad) [message ID: n2]');
    expect(out.indexOf("n1")).toBeLessThan(out.indexOf("n2"));
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("amazonaws");
    expect(out).not.toContain("bucket.example.com");
  });
});

function callTool(name: string, args: Record<string, unknown>): Request {
  return new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}
async function run(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const res = await handleMcpRequest(callTool(name, args), props, "t");
  const r = ((await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { text: r.content[0].text, isError: r.isError };
}

describe("send_message", () => {
  function stub(posts: Array<{ url: string; body: Record<string, unknown> }>): void {
    vi.stubGlobal("fetch", vi.fn(async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response(JSON.stringify({ data: { id: "n9", type: "nudge", attributes: {} } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(url.includes("/categories") ? categories : {}), { status: 200, headers: { "content-type": "application/json" } });
    }));
  }

  it("posts silent to everyone, with no sender, to the pinned endpoint", async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    stub(posts);
    const { text, isError } = await run("send_message", { body: "  Dinner at 6  " });
    expect(isError).toBeFalsy();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://app.ourskylight.com/api/frames/frame-1/nudges");
    expect(posts[0].body).toMatchObject({ body: "Dinner at 6", all_profiles: true, all_devices: true, voice_kind: "silent" });
    expect(posts[0].body).not.toHaveProperty("sender_category_id");
    expect(String(posts[0].body.deliver_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}-0[78]:00$/);
    expect(text).toContain('Posted to the frame: "Dinner at 6" [message ID: n9]');
  });

  it("resolves the sender by name and only speaks when asked", async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    stub(posts);
    await run("send_message", { body: "Hi", from: "dad", readAloud: true });
    expect(posts[0].body).toMatchObject({ sender_category_id: "k2", voice_kind: "kirk_voice" });
  });

  it("refuses an unknown sender or an over-long or blank message without posting", async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    stub(posts);
    const unknown = await run("send_message", { body: "Hi", from: "Nobody" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("No profile called");
    expect(unknown.text).toContain("Ben, Dad");
    const long = await run("send_message", { body: "x".repeat(301) });
    expect(long.isError).toBe(true);
    const blank = await run("send_message", { body: "   " });
    expect(blank.isError).toBe(true);
    expect(posts).toHaveLength(0);
  });
});
