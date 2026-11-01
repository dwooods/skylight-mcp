import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";
import { redactFeedUrl } from "../src/utils/redact.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };

async function callSources(): Promise<string> {
  const server = new McpServer({ name: "skylight", version: "t" });
  registerTools(server, { hasPlus: true, photos: false });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const req = new Request("https://w.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_source_calendars", arguments: {} } }),
  });
  const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
  const json = (await res.json()) as { result: { content: Array<{ text: string }> } };
  return json.result.content.map((c) => c.text).join("\n");
}

afterEach(() => vi.unstubAllGlobals());

describe("redactFeedUrl", () => {
  it("keeps only scheme and host of a feed address", () => {
    expect(redactFeedUrl("webcal://p1-caldav.example.com/published/2/SECRETTOKEN123")).toBe(
      "webcal://p1-caldav.example.com/... (feed address hidden)"
    );
    expect(redactFeedUrl("https://league.example.com/ajax/load?userId=777&cb=1")).toBe(
      "https://league.example.com/... (feed address hidden)"
    );
  });

  it("drops credentials embedded in the address", () => {
    const out = redactFeedUrl("https://user:hunter2@feeds.example.com/cal.ics?token=abc");
    expect(out).toBe("https://feeds.example.com/... (feed address hidden)");
    expect(out).not.toMatch(/hunter2|user|token/);
  });

  it("handles scheme case and surrounding whitespace", () => {
    expect(redactFeedUrl("  WEBCAL://Host.Example.com/x/y  ")).toBe("webcal://host.example.com/... (feed address hidden)");
  });

  it("hides a malformed address rather than echoing it", () => {
    expect(redactFeedUrl("https://")).toBe("(feed address hidden)");
  });

  it("leaves anything that is not a feed URL alone", () => {
    expect(redactFeedUrl("family123@group.calendar.example.com")).toBe("family123@group.calendar.example.com");
    expect(redactFeedUrl("Home")).toBe("Home");
  });
});

describe("get_source_calendars output", () => {
  function stub(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "1", type: "source_calendar", attributes: { label: "Family", kind: "gmail", role: "writer", editable: true, source_id: "family123@group.calendar.example.com" } },
              { id: "2", type: "source_calendar", attributes: { label: "Home", kind: "webcal", role: "reader", editable: false, source_id: "webcal://p1-caldav.example.com/published/2/SECRETTOKEN123" } },
              { id: "3", type: "source_calendar", attributes: { label: "League", kind: "webcal", role: "reader", editable: false, source_id: "https://league.example.com/ajax/load?userId=777&cb=1", extra_link: "http://other.example.com/private/abc" } },
            ],
          }),
          { status: 200 }
        )
      )
    );
  }

  it("never prints feed addresses, whichever field carries them", async () => {
    stub();
    const text = await callSources();
    for (const leaked of ["SECRETTOKEN123", "published/2", "userId=777", "/ajax/load", "private/abc"]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("webcal://p1-caldav.example.com/... (feed address hidden)");
    expect(text).toContain("extra_link: http://other.example.com/... (feed address hidden)");
  });

  it("still prints what the caller needs to decide editability", async () => {
    stub();
    const text = await callSources();
    expect(text).toContain("label: Home");
    expect(text).toContain("kind: webcal");
    expect(text).toContain("role: reader");
    expect(text).toContain("editable: false");
    expect(text).toContain("editable: true");
    expect(text).toContain("source_id: family123@group.calendar.example.com");
  });
});
