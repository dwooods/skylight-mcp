/**
 * The library's setup entry and read entry, run inside the Workers runtime (workerd via Miniflare)
 * with `nodejs_compat`, the way an importing Worker would run them. Node-based tests cannot show
 * that the sign-in's crypto, token exchange and client work there. Outbound requests never leave
 * the test: Miniflare hands them to `outboundService`, which records them and plays Skylight.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
type Call = { url: string; method: string; auth: string | null; body: string };
const calls: Call[] = [];
const removed = new Set<string>();
let renamed: string | null = null;
let mf: Miniflare;
let result: Record<string, unknown>;

beforeAll(async () => {
  execFileSync("npx", ["tsc"], { cwd: repo, stdio: "pipe" });
  const bundle = await build({
    entryPoints: [path.join(repo, "tests/worker-runtime/setup-worker.mjs")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import"],
    external: ["node:*"],
    write: false,
    logLevel: "silent",
  });
  // This Miniflare takes a new options shape; its own converter keeps the familiar one readable here.
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      calls.push({ url: request.url, method: request.method, auth: request.headers.get("authorization"), body: request.method === "GET" ? "" : await request.text() });
      if (url.pathname === "/oauth/token") return Response.json({ access_token: "AT-worker-1", refresh_token: "RT-worker-1", expires_in: 3600 });
      if (url.pathname.endsWith("/source_calendars")) {
        return Response.json({ data: [{ id: "2", type: "source_calendar", attributes: { label: "League", kind: "webcal", role: "reader", editable: false, source_id: "webcal://u:p@feeds.example.com/x/SECRETFEED?token=abc" } }] });
      }
      if (url.pathname.endsWith("/categories")) {
        return Response.json({ data: [{ id: "11", type: "category", attributes: { label: "Alex", color: "#2178AF", linked_to_profile: true } }] });
      }
      if (url.pathname.endsWith("/calendar_events") && request.method === "POST") return Response.json({ data: { id: "77", type: "calendar_event", attributes: {} } });
      if (/\/calendar_events\/\d+$/.test(url.pathname) && request.method === "DELETE") {
        removed.add(url.pathname.split("/").pop()!);
        return Response.json({ meta: { destroyed_id: url.pathname.split("/").pop() } });
      }
      if (/\/calendar_events\/\d+$/.test(url.pathname) && request.method === "PUT") {
        renamed = (JSON.parse(calls[calls.length - 1]!.body) as { summary?: string }).summary ?? null;
        return Response.json({ data: { id: "77" } });
      }
      if (url.pathname.endsWith("/calendar_events")) {
        return Response.json({
          data: removed.has("77") ? [] : [{
            id: "77", type: "calendar_event",
            attributes: { summary: renamed ?? "Wall entry", starts_at: "2037-03-03T16:00:00.000-08:00", ends_at: "2037-03-03T17:00:00.000-08:00", all_day: false, location: "", description: "", source: "skylight", editable: true },
            relationships: { categories: { data: [{ id: "11", type: "category" }] } },
          }],
        });
      }
      return Response.json({ data: [] });
    },
  }));
  const response = await mf.dispatchFetch("http://worker.test/");
  result = (await response.json()) as Record<string, unknown>;
}, 240_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("setup entry inside the Workers runtime (workerd, nodejs_compat)", () => {
  it("signs in with PKCE S256 and stores the credential, returning no secret", () => {
    expect(result.loginHost).toBe("app.ourskylight.com");
    expect(result.method).toBe("S256");
    expect(result.challengeOk).toBe(true);
    expect(result.verifierLength as number).toBeGreaterThanOrEqual(43);
    expect(result.stateLength).toBe(32);
    expect(result.statesDiffer).toBe(true);
    expect(result.done).toMatchObject({ signedIn: true });
    expect(result.status).toMatchObject({ signedIn: true, expired: false });
    expect(result.writes).toBe(1);
    expect(result.storedOk).toBe(true);
    for (const secret of ["AT-worker-1", "RT-worker-1", "CODE-W", result.verifier as string]) expect(result.returned as string).not.toContain(secret);
  });

  it("refuses a hostile address, a replay and a wrong state there too", () => {
    expect(result.hostile).toBe("bad_redirect_url");
    expect(result.replay).toBe("no_pending_login");
    expect(result.wrongState).toBe("state_mismatch");
  });

  it("sends the code and verifier only to the pinned host, once", () => {
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(new URL(c.url).origin).toBe("https://app.ourskylight.com");
    const token = calls.filter((c) => new URL(c.url).pathname === "/oauth/token");
    expect(token.length).toBe(1);
    expect(token[0]!.method).toBe("POST");
    const sent = new URLSearchParams(token[0]!.body);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("CODE-W");
    expect(sent.get("code_verifier")).toBe(result.verifier);
  });

  it("the stored credential then reads through createSkylight, with the feed address reduced to its host", () => {
    for (const c of calls.filter((c) => new URL(c.url).pathname !== "/oauth/token")) expect(c.auth).toBe("Bearer AT-worker-1");
    expect(result.sources).toEqual([{ id: "2", label: "League", kind: "feed", role: "reader", editable: false, host: "webcal://feeds.example.com", writable: false }]);
    expect(JSON.stringify(result.sources)).not.toContain("SECRETFEED");
  });
});

describe("event create inside the Workers runtime (workerd, nodejs_compat)", () => {
  it("previews, writes once to the pinned host and returns the read-back", () => {
    expect(result.preview).toMatchObject({ action: "create", title: "Wall entry", start: "2037-03-03T16:00:00.000-08:00", profileIds: ["11"], calendar: { id: "skylight" } });
    expect(result.created).toMatchObject({ id: "77", title: "Wall entry", profileIds: ["11"], source: "skylight" });
    const posts = calls.filter((c) => c.method === "POST" && new URL(c.url).pathname.endsWith("/calendar_events"));
    expect(posts).toHaveLength(1);
    expect(new URL(posts[0]!.url).origin).toBe("https://app.ourskylight.com");
    expect(posts[0]!.auth).toBe("Bearer AT-worker-1");
    expect(JSON.parse(posts[0]!.body)).toMatchObject({ summary: "Wall entry", starts_at: "2037-03-03T16:00:00.000-08:00", category_ids: ["11"] });
    expect(result.refused).toMatchObject({ name: "SkylightWriteError", code: "end_before_start" });
  });
});

describe("event update and delete inside the Workers runtime (workerd, nodejs_compat)", () => {
  it("updates with the version from a read, then deletes, each once, to the pinned host", () => {
    expect(result.renamed).toMatchObject({ id: "77", title: "Wall entry (moved)" });
    expect(result.deleted).toEqual({ deleted: true, id: "77", scope: null });
    expect(result.staleCode).toBe("stale");
    const writes = calls.filter((c) => c.method === "PUT" || c.method === "DELETE");
    expect(writes.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ["PUT", "/api/frames/123/calendar_events/77"],
      ["DELETE", "/api/frames/123/calendar_events/77"],
    ]);
    for (const c of writes) expect(new URL(c.url).origin).toBe("https://app.ourskylight.com");
  });
});
