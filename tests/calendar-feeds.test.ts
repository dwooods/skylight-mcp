import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SkylightClient } from "../src/api/client.js";
import { runWithContext } from "../src/context.js";
import { registerTools } from "../src/tools/registry.js";
import { addCalendarFeed, checkFeedUrl, scrubFeedText } from "../src/api/endpoints/source-calendars.js";
import { runCalendarsCommand } from "../src/calendars-cli.js";
import { PromptCancelled, promptHidden, type HiddenInput } from "../src/prompt-hidden.js";
import { HOSTED_EFFECTS, HOSTED_DESTRUCTIVE_ALLOWLIST } from "../src/worker/mcp.js";

const config = { frameId: "frame-1", timezone: "UTC", token: "test-access-1", authType: "bearer" as const };
const FEED = "https://calendar-api.example.com/v1/team.ics?token=SECRETTOKEN123&teamId=abc";
const SECRETS = ["SECRETTOKEN123", "token=", "team.ics"];

function inContext<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext({ client: new SkylightClient(config, null), config }, fn);
}

afterEach(() => vi.unstubAllGlobals());

describe("checkFeedUrl", () => {
  it("accepts web and webcal addresses and returns the host", () => {
    for (const u of [FEED, "webcal://p1-caldav.example.com/published/2/X", "http://ical.example.com/x.ics", "webcals://h.example.com/a"]) {
      expect(checkFeedUrl(u).ok).toBe(true);
    }
    expect(checkFeedUrl(FEED)).toMatchObject({ ok: true, host: "calendar-api.example.com" });
  });

  it("rejects anything that is not a web address, before anything is sent", () => {
    for (const u of ["", "   ", "file:///etc/passwd", "javascript:alert(1)", "ftp://x.example.com/a", "not a url", "https://", "https://a b.example.com", "family123@group.calendar.example.com"]) {
      expect(checkFeedUrl(u).ok).toBe(false);
    }
  });
});

describe("addCalendarFeed", () => {
  it("posts only sync_url to the pinned host and returns just the name and host", async () => {
    const calls: Array<{ url: string; method: string; body?: string; auth?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), method: String(init.method), body: init.body as string, auth: (init.headers as Record<string, string>).Authorization });
        return new Response(JSON.stringify({ data: { id: "1", type: "webcal_account", attributes: { sync_url: FEED, name: "Team Schedule" } } }), { status: 200 });
      })
    );
    const result = await inContext(() => addCalendarFeed(`  ${FEED}  `));
    expect(result).toEqual({ status: "added", host: "calendar-api.example.com", name: "Team Schedule" });
    expect(JSON.stringify(result)).not.toContain("SECRETTOKEN123");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://app.ourskylight.com/api/frames/frame-1/webcal_accounts");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ sync_url: FEED });
  });

  it("never sends the bearer token anywhere but the pinned host", async () => {
    const hosts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        hosts.push(new URL(String(url)).host);
        return new Response(JSON.stringify({ data: { attributes: { name: "X" } } }), { status: 200 });
      })
    );
    await inContext(() => addCalendarFeed("https://evil.example.net/steal.ics"));
    expect(hosts).toEqual(["app.ourskylight.com"]);
  });

  it("reports a duplicate as already synced, not as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: ["That URL is already synced to your Calendar"] }), { status: 422 })));
    expect(await inContext(() => addCalendarFeed(FEED))).toEqual({ status: "already_synced", host: "calendar-api.example.com" });
  });

  it("scrubs the address from an error that echoes it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [`Could not read ${FEED}`] }), { status: 422 })));
    const error = await inContext(() => addCalendarFeed(FEED)).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    for (const s of SECRETS) expect((error as Error).message).not.toContain(s);
  });

  it("scrubs a server error too, and sends nothing for a bad address", async () => {
    const fetchMock = vi.fn(async () => new Response(`upstream said ${FEED}`, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await inContext(() => addCalendarFeed(FEED)).catch((e: Error) => e);
    for (const s of SECRETS) expect((error as Error).message).not.toContain(s);
    fetchMock.mockClear();
    await expect(inContext(() => addCalendarFeed("file:///etc/passwd"))).rejects.toThrow(/must start with/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scrubFeedText removes any address-shaped text", () => {
    expect(scrubFeedText("bad https://a.example.com/x?k=1 and webcal://b.example.com/y", "")).toBe("bad (feed address hidden) and (feed address hidden)");
  });
});

describe("skylight-mcp calendars add", () => {
  function deps(answers: string[], addFeed = vi.fn(async () => ({ status: "added" as const, host: "calendar-api.example.com", name: "Team Schedule" }))) {
    const out: string[] = [];
    const queue = [...answers];
    return { out, addFeed, prompt: vi.fn(async () => queue.shift() ?? ""), run: (args: string[]) => runCalendarsCommand(args, { out: (l) => out.push(l), prompt: deps_prompt(queue), addFeed }) };
  }
  function deps_prompt(queue: string[]) {
    return async () => queue.shift() ?? "";
  }

  it("prints only the name and host, never the address", async () => {
    const d = deps([FEED]);
    expect(await d.run(["add"])).toBe(0);
    const text = d.out.join("\n");
    expect(text).toContain("Team Schedule");
    expect(text).toContain("calendar-api.example.com");
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(d.addFeed).toHaveBeenCalledWith(FEED);
  });

  it("refuses an address on the command line and sends nothing", async () => {
    const d = deps([FEED]);
    expect(await d.run(["add", FEED])).toBe(2);
    expect(d.addFeed).not.toHaveBeenCalled();
    for (const s of SECRETS) expect(d.out.join("\n")).not.toContain(s);
  });

  it("asks again after a bad address and gives up after three, sending nothing", async () => {
    const d = deps(["nope", "also nope", "still nope"]);
    expect(await d.run(["add"])).toBe(2);
    expect(d.addFeed).not.toHaveBeenCalled();
  });

  it("treats already synced as success", async () => {
    const d = deps([FEED], vi.fn(async () => ({ status: "already_synced" as const, host: "calendar-api.example.com" })));
    expect(await d.run(["add"])).toBe(0);
    expect(d.out.join("\n")).toContain("already synced");
  });

  it("does not leak the address when the call fails", async () => {
    const d = deps([FEED], vi.fn(async () => { throw new Error(`HTTP 500: ${scrubFeedText(FEED, FEED)}`); }));
    expect(await d.run(["add"])).toBe(1);
    for (const s of SECRETS) expect(d.out.join("\n")).not.toContain(s);
  });
});

describe("promptHidden", () => {
  function fakeInput(tty: boolean): HiddenInput & { emit: (c: string) => void; raw: boolean[] } {
    const ee = new EventEmitter();
    const raw: boolean[] = [];
    return {
      isTTY: tty,
      setRawMode: (m: boolean) => raw.push(m),
      resume: () => undefined,
      pause: () => undefined,
      setEncoding: () => undefined,
      on: (e, l) => ee.on(e, l as never),
      off: (e, l) => ee.off(e, l as never),
      emit: (c: string) => ee.emit("data", c),
      raw,
    };
  }

  it("returns what was typed without ever writing it to the output", async () => {
    const input = fakeInput(true);
    const written: string[] = [];
    const p = promptHidden("Address: ", { input, output: { write: (t) => written.push(t) } });
    input.emit(FEED.slice(0, 20));
    input.emit(`${FEED.slice(20)}\r`);
    expect(await p).toBe(FEED);
    const shown = written.join("");
    for (const s of SECRETS) expect(shown).not.toContain(s);
    expect(shown).toContain(`${FEED.length} characters`);
    expect(input.raw).toEqual([true, false]);
  });

  it("handles backspace and ignores control characters", async () => {
    const input = fakeInput(true);
    const p = promptHidden("> ", { input, output: { write: () => undefined } });
    input.emit("abcd\u007f\u007fX\u001b\n");
    expect(await p).toBe("abX");
  });

  it("cancels on Ctrl-C and restores the terminal", async () => {
    const input = fakeInput(true);
    const p = promptHidden("> ", { input, output: { write: () => undefined } });
    input.emit("ab\u0003");
    await expect(p).rejects.toBeInstanceOf(PromptCancelled);
    expect(input.raw).toEqual([true, false]);
  });
});

describe("delete_source_calendar", () => {
  const list = (ids: string[]) => ({
    data: [
      { id: "1", type: "source_calendar_detail", attributes: { label: "Family", kind: "gmail", role: "writer", source_id: "family@group.example.com", default_for_new_events: true } },
      { id: "2", type: "source_calendar_detail", attributes: { label: "Team", kind: "webcal", role: "reader", source_id: FEED, default_for_new_events: false } },
      { id: "3", type: "source_calendar_detail", attributes: { label: "Other", kind: "gmail", role: "owner", source_id: "o@example.com", default_for_new_events: false } },
    ].filter((c) => ids.includes(c.id)),
  });

  async function call(args: Record<string, unknown>, opts: { hosted?: boolean } = {}): Promise<string> {
    const server = new McpServer({ name: "skylight", version: "t" });
    registerTools(server, opts.hosted ? { hasPlus: true, effects: HOSTED_EFFECTS, include: HOSTED_DESTRUCTIVE_ALLOWLIST, photos: false } : { hasPlus: true, photos: false });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const req = new Request("https://w.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_source_calendar", arguments: args } }),
    });
    const res = await runWithContext({ client: new SkylightClient(config, null), config }, () => transport.handleRequest(req));
    const json = (await res.json()) as { result?: { content: Array<{ text: string }> }; error?: { message: string } };
    return json.result ? json.result.content.map((c) => c.text).join("\n") : `ERROR ${json.error?.message}`;
  }

  function stub(afterDelete: string[]): Array<{ method: string; url: string }> {
    const seen: Array<{ method: string; url: string }> = [];
    let deleted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ method: String(init.method), url: String(url) });
        if (init.method === "DELETE") {
          deleted = true;
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return new Response(JSON.stringify(list(deleted ? afterDelete : ["1", "2", "3"])), { status: 200 });
      })
    );
    return seen;
  }

  it("previews without deleting, and never shows the address", async () => {
    const seen = stub(["1", "3"]);
    const text = await call({ calendarId: "2" });
    expect(text).toContain("NOT REMOVED");
    expect(text).toContain("Team");
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(seen.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes the right path with confirm and reads back", async () => {
    const seen = stub(["1", "3"]);
    const text = await call({ calendarId: "2", confirm: true });
    expect(text).toContain("Confirmed gone");
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(seen.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["https://app.ourskylight.com/api/frames/frame-1/source_calendars/2"]);
  });

  it("refuses account calendars and the default calendar, deleting nothing", async () => {
    const seen = stub(["1", "2", "3"]);
    expect(await call({ calendarId: "3", confirm: true })).toMatch(/account calendar/);
    expect(await call({ calendarId: "1", confirm: true })).toMatch(/account calendar/);
    expect(seen.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("does not trust the delete call: still listed is an error", async () => {
    stub(["1", "2", "3"]);
    expect(await call({ calendarId: "2", confirm: true })).toMatch(/still listed/);
  });

  it("rejects unknown and non-numeric IDs", async () => {
    stub(["1", "2", "3"]);
    expect(await call({ calendarId: "99", confirm: true })).toMatch(/No synced calendar/);
    expect(await call({ calendarId: "../x", confirm: true })).toMatch(/numeric/);
  });

  it("is not registered on the hosted server", async () => {
    stub(["1", "3"]);
    expect(await call({ calendarId: "2", confirm: true }, { hosted: true })).toMatch(/not found/i);
  });
});
