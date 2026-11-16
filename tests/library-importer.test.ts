/**
 * Importer-side tests for the library entry (dist/lib.js). Each test runs a real Node child
 * process against the PACKED package installed into a temp project, with fetch replaced by
 * tests/library/stub-fetch.mjs, so it sees exactly what an importer sees: the exports map,
 * the packed files, and only the network calls the library makes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = "@davidwoods/skylight-mcp";
let tmp = "";
let proj = "";

const HIDDEN_KEYS = ["owner_email", "invited_emails", "uid", "calendar_id", "calendar_account_id", "supports_notification_settings", "source_id"];
const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/;

const event = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: "calendar_event",
  attributes: {
    summary: "Practice",
    starts_at: "2037-03-03T16:00:00.000-08:00",
    ends_at: "2037-03-03T17:00:00.000-08:00",
    all_day: false,
    location: "Gym",
    source: "google",
    editable: true,
    recurring: true,
    owner_email: "owner.person@example.com",
    invited_emails: ["guest.person@example.com"],
    uid: "uid-secret-1",
    calendar_id: "family-secret@group.calendar.example.com",
    calendar_account_id: "acct-secret-1",
    supports_notification_settings: false,
    ...over,
  },
  relationships: { categories: { data: [{ id: "11" }, { id: "90" }] } },
});

function fixtures(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "/calendar_events": { data: [event("101-1804032000")] },
    "/categories": {
      data: [
        { id: "11", type: "category", attributes: { label: "Alex", color: "#fff", linked_to_profile: true } },
        { id: "90", type: "category", attributes: { label: "Team", color: "#000", linked_to_profile: false } },
      ],
    },
    "/source_calendars": {
      data: [
        { id: "1", type: "source_calendar", attributes: { label: "person.one@example.com", kind: "gmail", role: "owner", editable: true, source_id: "person.one@example.com" } },
        { id: "2", type: "source_calendar", attributes: { label: "League", kind: "webcal", role: "reader", editable: false, source_id: "webcal://user:hunter2@feeds.example.com/published/2/SECRETTOKEN123?token=abc" } },
      ],
    },
    "/chores": { data: [{ id: "7", type: "chore", attributes: { summary: "Dishes", status: "pending", start: "2037-03-03", start_time: null, recurring: false, routine: false, reward_points: 2, up_for_grabs: false }, relationships: { category: { data: { id: "11", type: "category" } } } }], included: [{ id: "11", type: "category", attributes: { label: "Alex" } }] },
    "/meals/sittings": { data: [{ id: "5", type: "meal_sitting", attributes: { summary: "Tacos", instances: ["2037-03-03"], recurring: false }, relationships: { meal_category: { data: { id: "3", type: "x" } } } }] },
    "/meals/categories": { data: [{ id: "3", type: "meal_category", attributes: { label: "Dinner" } }] },
    "/meals/recipes": { data: [{ id: "8", type: "meal_recipe", attributes: { summary: "Soup" } }] },
    "/lists": { data: [{ id: "5", type: "list", attributes: { label: "Groceries", kind: "shopping", color: "#abc" } }] },
    "/lists/5": { data: { id: "5", type: "list", attributes: { label: "Groceries" } }, included: [{ id: "50", type: "list_item", attributes: { label: "Milk", status: "pending", section: null } }] },
    ...over,
  };
}

/** Run `body` (ESM source) in a child that imports the package and has fetch stubbed. Returns parsed stdout and recorded calls. */
type Call = { url: string; host: string; auth: string | null; method?: string; body?: string | null };
function runImporter(body: string, fx: Record<string, unknown> = fixtures(), argv: string[] = [], prelude = ""): { out: unknown; calls: Call[]; stderr: string; status: number | null } {
  const fxFile = path.join(tmp, "fx.json");
  const callsFile = path.join(tmp, "calls.json");
  fs.writeFileSync(fxFile, JSON.stringify(fx));
  fs.rmSync(callsFile, { force: true });
  const script = path.join(proj, "run.mjs");
  fs.writeFileSync(script, `import * as lib from "${PKG}";\n${prelude}\nconst result = await (async () => {\n${body}\n})();\nconsole.log(JSON.stringify(result ?? null));\n`);
  const r = spawnSync(process.execPath, ["--import", path.join(repo, "tests/library/stub-fetch.mjs"), script, ...argv], {
    cwd: proj,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", LIB_FIXTURES: fxFile, LIB_CALLS: callsFile },
    timeout: 30_000,
  });
  const calls = fs.existsSync(callsFile) ? (JSON.parse(fs.readFileSync(callsFile, "utf8")) as Call[]) : [];
  let out: unknown = null;
  try {
    out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "null");
  } catch {
    out = r.stdout;
  }
  return { out, calls, stderr: r.stderr, status: r.status };
}

const make = `const sky = lib.createSkylight({ frameId: "123", timezone: "America/Los_Angeles", credential: { token: "tok-test-1" } });`;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skylight-lib-"));
  proj = path.join(tmp, "importer");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "importer", type: "module", private: true }));
  // Build, pack exactly what would be published, and unpack it where an importer would find it.
  execFileSync("npx", ["tsc"], { cwd: repo, stdio: "pipe" });
  const packOut = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", tmp], { cwd: repo, encoding: "utf8" });
  const tarball = path.join(tmp, (JSON.parse(packOut) as Array<{ filename: string }>)[0]!.filename.replace(/^@/, "").replace("/", "-"));
  const dest = path.join(proj, "node_modules", "@davidwoods", "skylight-mcp");
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", dest, "--strip-components=1"]);
  // Runtime dependencies come from this repo's install (no network in tests).
  for (const dep of ["zod", "@modelcontextprotocol/sdk", "@cloudflare/workers-oauth-provider"]) {
    const target = path.join(proj, "node_modules", dep);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(repo, "node_modules", dep), target, "dir");
  }
}, 180_000);

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("library entry, from the importer's side (packed package)", () => {
  it("1. public surface is exactly the listed names", () => {
    const { out } = runImporter(`return Object.keys(lib).sort();`);
    expect(out).toEqual(["createSkylight"]);
  });

  it("1b. the created object has exactly the Phase 1 read methods, no more", () => {
    const { out } = runImporter(`${make}\nreturn Object.fromEntries(Object.entries(sky).map(([k, v]) => [k, Object.keys(v).sort()]));`);
    expect(out).toEqual({
      calendar: ["create", "events", "previewCreate", "sources"],
      profiles: ["list"],
      labels: ["list"],
      chores: ["list"],
      meals: ["categories", "recipes", "sittings"],
      lists: ["items", "list"],
    });
  });

  it("2. deep imports of internals fail; package.json stays readable", () => {
    const { out } = runImporter(`
      const codes = {};
      for (const sub of ["dist/api/client.js", "dist/index.js", "dist/context.js", "src/lib.ts"]) {
        try { await import("${PKG}/" + sub); codes[sub] = "imported"; } catch (e) { codes[sub] = e.code; }
      }
      return codes;`);
    for (const code of Object.values(out as Record<string, string>)) expect(code).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
    const pj = runImporter(`const m = await import("${PKG}/package.json", { with: { type: "json" } }); return m.default.name;`);
    expect(pj.out).toBe(PKG);
  });

  it("3. importing starts no server and does not act on process.argv", () => {
    const r = runImporter(`return "ok";`, fixtures(), ["auth", "login"]);
    expect(r.status).toBe(0);
    expect(r.out).toBe("ok");
    expect(r.calls).toEqual([]);
    expect(r.stderr).not.toMatch(/running on stdio|Logged in|Open this/i);
  });

  it("4. the token never leaves the pinned host, whatever the options or arguments say", () => {
    const hostile = runImporter(`
      const bad = [];
      for (const extra of [{ baseUrl: "https://evil.example" }, { host: "evil.example" }, { apiBase: "//evil.example" }, { fetch: () => {} }, { SKYLIGHT_BASE_URL: "https://evil.example" }]) {
        try { lib.createSkylight({ frameId: "123", timezone: "America/Los_Angeles", credential: { token: "tok" }, ...extra }); bad.push(Object.keys(extra)[0]); } catch {}
      }
      for (const frameId of ["123/../../x", "123?x=1", "//evil.example", "abc"]) {
        try { lib.createSkylight({ frameId, timezone: "America/Los_Angeles", credential: { token: "tok" } }); bad.push(frameId); } catch {}
      }
      try { lib.createSkylight({ frameId: "123", timezone: "America/Los_Angeles", credential: { token: "tok", baseUrl: "https://evil.example" } }); bad.push("credential.baseUrl"); } catch {}
      return bad;`);
    expect(hostile.out).toEqual([]);

    const r = runImporter(`${make}
      const refused = [];
      for (const call of [() => sky.lists.items("//evil.example/x"), () => sky.lists.items("5/../../x"), () => sky.calendar.events({ from: "https://evil.example", to: "2037-03-04" }), () => sky.chores.list({ date: "2037-03-03?x=1" })]) {
        try { await call(); } catch { refused.push(true); }
      }
      await sky.calendar.events({ from: "2037-03-03", to: "2037-03-04" });
      await sky.calendar.sources();
      await sky.profiles.list();
      await sky.labels.list();
      await sky.chores.list({ date: "2037-03-03", profile: "Alex" });
      await sky.meals.sittings({ from: "2037-03-03", to: "2037-03-04" });
      await sky.meals.recipes();
      await sky.meals.categories();
      await sky.lists.list();
      await sky.lists.items("5");
      return refused.length;`);
    expect(r.out).toBe(4);
    expect(r.calls.length).toBeGreaterThan(8);
    for (const c of r.calls) {
      expect(c.host).toBe("app.ourskylight.com");
      expect(c.auth).toBe("Bearer tok-test-1");
    }
  });

  it("5. sources() carries no feed path, query, credentials or email address", () => {
    const { out } = runImporter(`${make}\nreturn await sky.calendar.sources();`);
    const text = JSON.stringify(out);
    for (const secret of ["SECRETTOKEN123", "hunter2", "token=abc", "published", "person.one@example.com"]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(EMAIL);
    const feed = (out as Array<{ kind: string; host: string | null }>).find((s) => s.kind === "feed")!;
    expect(feed.host).toBe("webcal://feeds.example.com");
    expect((out as Array<{ kind: string; label: string }>).find((s) => s.kind === "google")!.label).toBe("Google calendar");
  });

  it("6. events() has no hidden field and no email-shaped value", () => {
    const { out } = runImporter(`${make}\nreturn await sky.calendar.events({ from: "2037-03-03", to: "2037-03-03" });`);
    const events = out as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    for (const key of HIDDEN_KEYS) expect(Object.keys(events[0]!)).not.toContain(key);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(EMAIL);
    for (const secret of ["uid-secret-1", "family-secret", "acct-secret-1"]) expect(text).not.toContain(secret);
    expect(events[0]).toMatchObject({ title: "Practice", profiles: ["Alex"], labels: ["Team"], profileIds: ["11"], labelIds: ["90"], source: "google", seriesId: "101", recurring: true, allDay: false });
  });

  it("7. every return value is JSON-safe (survives a round trip unchanged)", () => {
    const { out } = runImporter(`${make}
      const all = {
        events: await sky.calendar.events({ from: "2037-03-03", to: "2037-03-04" }),
        sources: await sky.calendar.sources(),
        profiles: await sky.profiles.list(),
        labels: await sky.labels.list(),
        chores: await sky.chores.list({ date: "2037-03-03" }),
        sittings: await sky.meals.sittings({ from: "2037-03-03", to: "2037-03-04" }),
        recipes: await sky.meals.recipes(),
        mealCategories: await sky.meals.categories(),
        lists: await sky.lists.list(),
        items: await sky.lists.items("5"),
      };
      return { all, same: JSON.stringify(JSON.parse(JSON.stringify(all))) === JSON.stringify(all) };`);
    const r = out as { all: Record<string, unknown[]>; same: boolean };
    expect(r.same).toBe(true);
    for (const [name, rows] of Object.entries(r.all)) expect(rows.length, name).toBeGreaterThan(0);
    expect(r.all.sittings![0]).toMatchObject({ title: "Tacos", category: "Dinner", dates: ["2037-03-03"] });
    expect(r.all.chores![0]).toMatchObject({ title: "Dishes", profile: "Alex", points: 2, done: false });
  });

  it("8. no function takes a URL or a feed address", () => {
    const r = runImporter(`${make}
      const results = [];
      const attempt = async (fn) => { try { await fn(); results.push("accepted"); } catch { results.push("refused"); } };
      await attempt(() => sky.lists.items("https://evil.example/x"));
      await attempt(() => sky.calendar.events({ from: "webcal://feeds.example.com/x", to: "2037-03-04" }));
      await attempt(() => sky.meals.sittings({ from: "2037-03-03", to: "https://evil.example" }));
      return { results, arities: [lib.createSkylight.length, sky.calendar.events.length, sky.lists.items.length], hasUrlish: Object.keys(lib).some((k) => /url|feed|webcal/i.test(k)) };`);
    const o = r.out as { results: string[]; arities: number[]; hasUrlish: boolean };
    expect(o.results).toEqual(["refused", "refused", "refused"]);
    expect(o.arities).toEqual([1, 1, 1]);
    expect(o.hasUrlish).toBe(false);
    // The shipped type declarations name no URL, feed or host option either.
    const dts = fs.readFileSync(path.join(proj, "node_modules/@davidwoods/skylight-mcp/dist/lib.d.ts"), "utf8");
    expect(dts).not.toMatch(/baseUrl|apiBase|feedUrl|webcal|fetch\??:/i);
  });

  it("9. a series' occurrence id changes after a time edit, so ids cannot be relied on", () => {
    const before = runImporter(`${make}\nreturn await sky.calendar.events({ from: "2037-03-03", to: "2037-03-03" });`, fixtures({ "/calendar_events": { data: [event("101-1804032000")] } }));
    const after = runImporter(`${make}\nreturn await sky.calendar.events({ from: "2037-03-03", to: "2037-03-03" });`, fixtures({ "/calendar_events": { data: [event("101-1804035600", { starts_at: "2037-03-03T17:00:00.000-08:00" })] } }));
    const a = (before.out as Array<{ id: string; seriesId: string }>)[0]!;
    const b = (after.out as Array<{ id: string; seriesId: string }>)[0]!;
    expect(a.id).not.toBe(b.id);
    expect(a.seriesId).toBe("101");
    expect(b.seriesId).toBe("101");
    const dts = fs.readFileSync(path.join(proj, "node_modules/@davidwoods/skylight-mcp/dist/lib.d.ts"), "utf8");
    expect(dts).toMatch(/opaque/i);
    expect(dts).toMatch(/CHANGE after a time edit/);
  });
});

describe("label colours (Mantel request, 2026-11-15)", () => {
  const cat = (id: string, label: unknown, color: unknown, profile: boolean | undefined) => ({
    id,
    type: "category",
    attributes: { label, color, ...(profile === undefined ? {} : { linked_to_profile: profile }) },
  });
  const categories = [
    cat("11", "Alex", "#2178AF", true),
    cat("90", "Team", "#CB434C", false), // a feed label
    cat("91", "US Holidays", "#82D7DD", false), // the holidays label
    cat("92", "Unused", "#DADADA", false), // no event carries it
    cat("93", "No colour", null, false),
    cat("94", "Odd colour", 42, false),
    cat("95", "", "#000000", false), // nameless: not listed
    cat("96", "Legacy", "#B6E085", undefined), // no linked_to_profile at all: a label
    cat("97", "person.two@example.com", "#F66951", false), // email-shaped
    cat("98", "Team", "#FDB305", false), // a second label with the same name
  ];

  it("L1. labels.list returns every category that is not a profile, in Skylight's order, as { id, label, color }", () => {
    const { out } = runImporter(`${make}\nreturn await sky.labels.list();`, fixtures({ "/categories": { data: categories } }));
    expect(out).toEqual([
      { id: "90", label: "Team", color: "#CB434C" },
      { id: "91", label: "US Holidays", color: "#82D7DD" },
      { id: "92", label: "Unused", color: "#DADADA" },
      { id: "93", label: "No colour", color: null },
      { id: "94", label: "Odd colour", color: null },
      { id: "96", label: "Legacy", color: "#B6E085" },
      { id: "97", label: "Calendar", color: "#F66951" },
      { id: "98", label: "Team", color: "#FDB305" },
    ]);
  });

  it("L2. profiles and labels never overlap: each named category is in exactly one list", () => {
    const { out } = runImporter(`${make}\nreturn { p: (await sky.profiles.list()).map((x) => x.id), l: (await sky.labels.list()).map((x) => x.id) };`, fixtures({ "/categories": { data: categories } }));
    const o = out as { p: string[]; l: string[] };
    expect(o.p).toEqual(["11"]);
    expect(o.p.filter((id) => o.l.includes(id))).toEqual([]);
    expect([...o.p, ...o.l].sort()).toEqual(["11", "90", "91", "92", "93", "94", "96", "97", "98"]);
  });

  it("L3. an email-shaped label name is replaced in labels.list AND events, so the names match and no address leaves", () => {
    const withEmail = event("101-1804032000");
    withEmail.relationships = { categories: { data: [{ id: "11" }, { id: "97" }] } };
    const { out } = runImporter(
      `${make}\nreturn { labels: await sky.labels.list(), events: await sky.calendar.events({ from: "2037-03-03", to: "2037-03-03" }) };`,
      fixtures({ "/categories": { data: categories }, "/calendar_events": { data: [withEmail] } })
    );
    const o = out as { labels: Array<{ label: string }>; events: Array<{ labels: string[] }> };
    expect(JSON.stringify(out)).not.toMatch(EMAIL);
    expect(o.events[0]!.labels).toEqual(["Calendar"]);
    expect(o.labels.map((l) => l.label)).toContain(o.events[0]!.labels[0]);
  });

  it("L4. two labels with the same name are told apart by id: events carry labelIds that match labels.list", () => {
    const both = event("101-1804032000");
    both.relationships = { categories: { data: [{ id: "11" }, { id: "98" }, { id: "91" }] } };
    const { out } = runImporter(
      `${make}\nreturn { labels: await sky.labels.list(), events: await sky.calendar.events({ from: "2037-03-03", to: "2037-03-03" }) };`,
      fixtures({ "/categories": { data: categories }, "/calendar_events": { data: [both] } })
    );
    const o = out as { labels: Array<{ id: string; label: string; color: string | null }>; events: Array<{ labels: string[]; labelIds: string[]; profileIds: string[] }> };
    const e = o.events[0]!;
    expect(e.labels).toEqual(["Team", "US Holidays"]);
    expect(e.labelIds).toEqual(["98", "91"]);
    expect(e.profileIds).toEqual(["11"]);
    // The id, not the name, picks the colour: "Team" alone would be ambiguous (two labels, two colours).
    expect(e.labelIds.map((id) => o.labels.find((l) => l.id === id)!.color)).toEqual(["#FDB305", "#82D7DD"]);
    expect(o.labels.filter((l) => l.label === "Team")).toHaveLength(2);
  });

  it("L5. labels.list is one GET of categories to the pinned host and takes no argument", () => {
    const { out, calls } = runImporter(`${make}\nconst before = sky.labels.list.length; await sky.labels.list(); return { before };`);
    expect(out).toEqual({ before: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.host).toBe("app.ourskylight.com");
    expect(new URL(calls[0]!.url).pathname).toMatch(/\/categories$/);
    expect((calls[0]!.method ?? "GET").toUpperCase()).toBe("GET");
    expect(calls[0]!.auth).toBe("Bearer tok-test-1");
  });

  it("L6. the shipped type declarations show LabelDto and the id fields", () => {
    const dts = fs.readFileSync(path.join(proj, "node_modules/@davidwoods/skylight-mcp/dist/lib.d.ts"), "utf8");
    expect(dts).toMatch(/interface LabelDto/);
    expect(dts).toMatch(/labels: \{\s*list\(\): Promise<LabelDto\[\]>/);
    expect(dts).toMatch(/labelIds: string\[\]/);
    expect(dts).toMatch(/profileIds: string\[\]/);
  });
});

describe("event create, stage 1 of library writes (2026-11-15)", () => {
  const cats = [
    { id: "11", type: "category", attributes: { label: "Alex", color: "#2178AF", linked_to_profile: true } },
    { id: "12", type: "category", attributes: { label: "Jordan", color: "#CB434C", linked_to_profile: true } },
    { id: "90", type: "category", attributes: { label: "Team", color: "#B6E085", linked_to_profile: false }, relationships: { source_calendars: { data: [{ id: "2", type: "source_calendar" }] } } },
    { id: "91", type: "category", attributes: { label: "Chores", color: "#DADADA", linked_to_profile: false }, relationships: { source_calendars: { data: [] } } },
  ];
  const ADDRESS = "family-secret@group.calendar.example.com";
  const sources = {
    data: [
      { id: "1", type: "source_calendar", attributes: { label: "person.one@example.com", kind: "gmail", role: "owner", editable: true, source_id: ADDRESS }, relationships: { calendar_account: { data: { id: "777", type: "calendar_account" } } } },
      { id: "2", type: "source_calendar", attributes: { label: "League", kind: "webcal", role: "reader", editable: false, source_id: "webcal://feeds.example.com/x/SECRETTOKEN123" }, relationships: { calendar_account: { data: null } } },
      { id: "3", type: "source_calendar", attributes: { label: "Shared", kind: "gmail", role: "reader", editable: false, source_id: "shared@group.calendar.example.com" }, relationships: { calendar_account: { data: { id: "778", type: "calendar_account" } } } },
      { id: "4", type: "source_calendar", attributes: { label: "Orphan", kind: "gmail", role: "owner", editable: true, source_id: "orphan@group.calendar.example.com" }, relationships: { calendar_account: { data: null } } },
    ],
    included: [{ id: "777", type: "calendar_account", attributes: { email: "account.owner@example.com", provider: "google" } }],
  };
  const input = { title: "Practice", start: "2037-03-03T16:00", end: "2037-03-03T17:00", location: "Gym", notes: "Bring water", profileIds: ["11"], labelIds: ["91"], calendar: "skylight" };
  const stored = (over: Record<string, unknown> = {}, cats: string[] = ["11", "91"]) => ({
    id: "5001",
    type: "calendar_event",
    attributes: {
      summary: "Practice", starts_at: "2037-03-03T16:00:00.000-08:00", ends_at: "2037-03-03T17:00:00.000-08:00", all_day: false,
      location: "Gym", description: "Bring water", source: "skylight", editable: true, recurring: false, timezone: "America/Los_Angeles",
      owner_email: "owner.person@example.com", calendar_id: null, uid: "uid-secret-9", ...over,
    },
    relationships: { categories: { data: cats.map((id) => ({ id, type: "category" })) } },
  });
  const fx = (over: Record<string, unknown> = {}) =>
    fixtures({
      "/categories": { data: cats },
      "/source_calendars": sources,
      "POST /calendar_events": { data: { id: "5001", type: "calendar_event", attributes: {} } },
      "/calendar_events": { data: [stored()] },
      ...over,
    });
  const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");
  const tryCall = (expr: string) => `try { return { ok: true, value: await ${expr} }; } catch (e) { return { ok: false, name: e.name, code: e.code, status: e.status, ids: e.ids, eventId: e.eventId, message: String(e.message) }; }`;

  it("W1. previewCreate changes nothing and returns what would be written, times with the frame's offset", () => {
    const { out, calls } = runImporter(`${make}\nreturn await sky.calendar.previewCreate(${JSON.stringify(input)});`, fx());
    expect(posts(calls)).toEqual([]);
    for (const c of calls) expect(c.method).toBe("GET");
    expect(out).toEqual({
      action: "create", title: "Practice", start: "2037-03-03T16:00:00.000-08:00", end: "2037-03-03T17:00:00.000-08:00", allDay: false,
      location: "Gym", notes: "Bring water", profileIds: ["11"], profiles: ["Alex"], labelIds: ["91"], labels: ["Chores"],
      calendar: { id: "skylight", label: "Skylight", kind: "skylight" }, timezone: "America/Los_Angeles",
    });
  });

  it("W2. create sends exactly what the preview showed, once, to the pinned host, and returns the read-back as an EventDto", () => {
    const { out, calls } = runImporter(`${make}\nconst p = await sky.calendar.previewCreate(${JSON.stringify(input)});\nconst e = await sky.calendar.create(${JSON.stringify(input)});\nreturn { p, e };`, fx());
    const o = out as { p: Record<string, unknown>; e: Record<string, unknown> };
    const sent = posts(calls);
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).pathname).toBe("/api/frames/123/calendar_events");
    const body = JSON.parse(sent[0]!.body!);
    expect(body).toEqual({
      summary: o.p.title, kind: "standard", starts_at: o.p.start, ends_at: o.p.end, all_day: o.p.allDay, timezone: o.p.timezone,
      description: o.p.notes, location: o.p.location, category_ids: [...(o.p.profileIds as string[]), ...(o.p.labelIds as string[])],
    });
    for (const c of calls) {
      expect(c.host).toBe("app.ourskylight.com");
      expect(c.auth).toBe("Bearer tok-test-1");
    }
    expect(o.e).toMatchObject({ id: "5001", title: "Practice", profiles: ["Alex"], labels: ["Chores"], profileIds: ["11"], labelIds: ["91"], source: "skylight", allDay: false });
    const text = JSON.stringify(o.e);
    expect(text).not.toMatch(EMAIL);
    expect(text).not.toContain("uid-secret-9");
  });

  it("W3. a Google target is chosen by its sources() id; the address and account go to Skylight only, never back to the importer", () => {
    const g = { ...input, calendar: "1" };
    const { out, calls } = runImporter(
      `${make}\nconst sources = await sky.calendar.sources();\nconst p = await sky.calendar.previewCreate(${JSON.stringify(g)});\nconst e = await sky.calendar.create(${JSON.stringify(g)});\nreturn { sources, p, e };`,
      fx({ "/calendar_events": { data: [stored({ source: "google", calendar_id: ADDRESS })] } })
    );
    const o = out as { sources: Array<{ id: string; writable: boolean }>; p: { calendar: unknown }; e: unknown };
    expect(o.sources.map((x) => [x.id, x.writable])).toEqual([["1", true], ["2", false], ["3", false], ["4", true]]);
    expect(o.p.calendar).toEqual({ id: "1", label: "Google calendar", kind: "google" });
    const body = JSON.parse(posts(calls)[0]!.body!);
    expect(body.calendar_id).toBe(ADDRESS);
    expect(body.calendar_account_id).toBe("777");
    const text = JSON.stringify(out);
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain("777");
    expect(text).not.toMatch(EMAIL);
    expect(text).not.toContain("SECRETTOKEN123");
  });

  it("W4. an all-day event is one date, sent with the next day as Skylight's exclusive end", () => {
    const a = { title: "Field trip", start: "2037-03-04", allDay: true, calendar: "skylight" };
    const { out, calls } = runImporter(
      `${make}\nconst p = await sky.calendar.previewCreate(${JSON.stringify(a)});\nconst e = await sky.calendar.create(${JSON.stringify(a)});\nreturn { p, e };`,
      fx({ "/calendar_events": { data: [stored({ summary: "Field trip", all_day: true, starts_at: "2037-03-04T00:00:00.000-08:00", ends_at: "2037-03-05T00:00:00.000-08:00", location: null, description: null }, [])] } })
    );
    const o = out as { p: Record<string, unknown>; e: Record<string, unknown> };
    expect(o.p).toMatchObject({ start: "2037-03-04", end: "2037-03-05", allDay: true, location: null, notes: null });
    expect(JSON.parse(posts(calls)[0]!.body!)).toMatchObject({ starts_at: "2037-03-04", ends_at: "2037-03-05", all_day: true, category_ids: [] });
    expect(o.e).toMatchObject({ title: "Field trip", allDay: true });
  });

  it("W5. every bad input is refused by preview AND create with a stable code, before any write", () => {
    const cases: Array<[Record<string, unknown>, string, string[]?]> = [
      [{ ...input, colour: "red" }, "bad_input"],
      [{ ...input, title: "  " }, "invalid_title"],
      [{ ...input, title: "two\nlines" }, "invalid_title"],
      [{ ...input, start: "2037-03-03T16:00:00-08:00" }, "invalid_time"],
      [{ ...input, start: "2037-02-30T16:00" }, "invalid_time"],
      [{ ...input, start: "2037-03-08T02:30", end: "2037-03-08T03:30" }, "invalid_time"],
      [{ ...input, end: "2037-03-03T16:00" }, "end_before_start"],
      [{ ...input, end: "2037-03-03T15:00" }, "end_before_start"],
      [{ title: "Trip", start: "2037-03-04", end: "2037-03-06", allDay: true, calendar: "skylight" }, "unsupported"],
      [{ ...input, profileIds: ["91"] }, "unknown_profile", ["91"]],
      [{ ...input, profileIds: ["999"] }, "unknown_profile", ["999"]],
      [{ ...input, labelIds: ["11"] }, "unknown_label", ["11"]],
      [{ ...input, labelIds: ["90"] }, "label_not_assignable", ["90"]],
      [{ ...input, profileIds: ["11", "11"] }, "bad_input"],
      [{ ...input, calendar: "999" }, "unknown_calendar"],
      [{ ...input, calendar: "2" }, "calendar_not_writable"],
      [{ ...input, calendar: "3" }, "calendar_not_writable"],
      [{ ...input, calendar: "4" }, "calendar_not_writable"],
      [{ ...input, calendar: "https://evil.example" }, "bad_input"],
      [(({ calendar, ...rest }) => rest)(input), "bad_input"],
    ];
    const { out, calls } = runImporter(
      `${make}
      const cases = ${JSON.stringify(cases.map((c) => c[0]))};
      const res = [];
      for (const c of cases) {
        for (const fn of ["previewCreate", "create"]) {
          try { await sky.calendar[fn](c); res.push({ fn, ok: true }); }
          catch (e) { res.push({ fn, name: e.name, code: e.code, ids: e.ids ?? null }); }
        }
      }
      return res;`,
      fx()
    );
    const res = out as Array<{ fn: string; name: string; code: string; ids: string[] | null }>;
    cases.forEach(([, code, ids], i) => {
      for (const r of [res[2 * i]!, res[2 * i + 1]!]) {
        expect(r, `${r.fn} case ${i}`).toMatchObject({ name: "SkylightWriteError", code });
        if (ids) expect(r.ids).toEqual(ids);
      }
    });
    expect(posts(calls)).toEqual([]);
  });

  it("W6. Skylight's own error text never reaches the importer; a refusal and an unknown outcome are told apart", () => {
    const refused = runImporter(`${make}\n${tryCall(`sky.calendar.create(${JSON.stringify(input)})`)}`, fx({ "POST /calendar_events": { __status: 422, errors: ["SKYLIGHT_SAYS_SECRET person.two@example.com"] } }));
    expect(refused.out).toMatchObject({ ok: false, name: "SkylightWriteError", code: "skylight_refused", status: 422 });
    const server = runImporter(`${make}\n${tryCall(`sky.calendar.create(${JSON.stringify(input)})`)}`, fx({ "POST /calendar_events": { __status: 503, errors: ["SKYLIGHT_SAYS_SECRET"] } }));
    expect(server.out).toMatchObject({ ok: false, name: "SkylightWriteError", code: "outcome_unknown" });
    const network = runImporter(`${make}\n${tryCall(`sky.calendar.create(${JSON.stringify(input)})`)}`, fx({ "POST /calendar_events": { __throw: true } }));
    expect(network.out).toMatchObject({ ok: false, name: "SkylightWriteError", code: "outcome_unknown" });
    for (const r of [refused, server]) {
      expect(JSON.stringify(r.out)).not.toContain("SKYLIGHT_SAYS_SECRET");
      expect(JSON.stringify(r.out)).not.toMatch(EMAIL);
      expect(posts(r.calls)).toHaveLength(1);
    }
  });

  it("W7. a list that lags the write is waited for; one that never shows it, or shows other fields, is not_confirmed with the new id", () => {
    const empty = { data: [] };
    const lag = runImporter(`${make}\n${tryCall(`sky.calendar.create(${JSON.stringify(input)})`)}`, fx({ "/calendar_events": { __sequence: [empty, empty, { data: [stored()] }] } }));
    expect(lag.out).toMatchObject({ ok: true, value: { id: "5001", title: "Practice" } });
    const never = runImporter(`${make}\n${tryCall(`sky.calendar.create(${JSON.stringify(input)})`)}`, fx({ "/calendar_events": empty }));
    expect(never.out).toMatchObject({ ok: false, name: "SkylightWriteError", code: "not_confirmed", eventId: "5001" });
    expect(posts(never.calls)).toHaveLength(1);
    const wrong = runImporter(`${make}\n${tryCall(`sky.calendar.create(${JSON.stringify(input)})`)}`, fx({ "/calendar_events": { data: [stored({ starts_at: "2037-03-03T17:00:00.000-08:00" })] } }));
    expect(wrong.out).toMatchObject({ ok: false, code: "not_confirmed", eventId: "5001" });
    const noProfile = runImporter(`${make}\n${tryCall(`sky.calendar.create(${JSON.stringify(input)})`)}`, fx({ "/calendar_events": { data: [stored({}, ["91"])] } }));
    expect(noProfile.out).toMatchObject({ ok: false, code: "not_confirmed" });
    const extraLabel = runImporter(`${make}\n${tryCall(`sky.calendar.create(${JSON.stringify(input)})`)}`, fx({ "/calendar_events": { data: [stored({}, ["11", "91", "90"])] } }));
    expect(extraLabel.out).toMatchObject({ ok: true, value: { labelIds: ["91", "90"] } });
  }, 30_000);

  it("W8. a sign-in failure stays an AuthenticationError, not a write error", () => {
    const { out } = runImporter(`${make}\n${tryCall(`sky.calendar.create(${JSON.stringify(input)})`)}`, fx({ "POST /calendar_events": { __status: 401 } }));
    expect(out).toMatchObject({ ok: false, name: "AuthenticationError" });
  });

  it("W9. the root still exports only createSkylight; the declarations carry the write types", () => {
    const { out } = runImporter(`return Object.keys(lib);`);
    expect(out).toEqual(["createSkylight"]);
    const dts = fs.readFileSync(path.join(proj, "node_modules/@davidwoods/skylight-mcp/dist/lib.d.ts"), "utf8");
    expect(dts).toMatch(/previewCreate\(input: CreateEventInput\): Promise<CreatePreview>/);
    expect(dts).toMatch(/create\(input: CreateEventInput\): Promise<EventDto>/);
    expect(dts).toMatch(/writable: boolean/);
  });
});

describe("importer gaps reported by Mantel (2026-11-10)", () => {
  it("G1. a library client writes no per-request trace lines", () => {
    const { stderr, status } = runImporter(`
      const sky = lib.createSkylight({ frameId: "123", timezone: "America/Los_Angeles", credential: { token: "t" } });
      await sky.calendar.events({ from: "2037-03-03", to: "2037-03-03" });
      await sky.profiles.list();
      return true;`);
    expect(status).toBe(0);
    expect(stderr).not.toMatch(/\[client\] (GET|POST|PUT|DELETE|Response)/);
  });

  it("G2. chores take one day or a range; the range is sent as given; bad shapes are refused before any request", () => {
    const { out, calls } = runImporter(`
      const sky = lib.createSkylight({ frameId: "123", timezone: "America/Los_Angeles", credential: { token: "t" } });
      const range = await sky.chores.list({ from: "2037-03-01", to: "2037-03-07" });
      const refused = [];
      for (const bad of [{ date: "2037-03-01", from: "2037-03-01", to: "2037-03-02" }, { from: "2037-03-01", to: "2037-04-15" }, { from: "2037-03-07", to: "2037-03-01" }, { from: "2037-03-01" }, { day: "2037-03-01" }]) {
        try { await sky.chores.list(bad); refused.push("accepted"); } catch (e) { refused.push("refused"); }
      }
      return { range, refused };`);
    const o = out as { range: Array<{ title: string }>; refused: string[] };
    expect(o.refused).toEqual(["refused", "refused", "refused", "refused", "refused"]);
    expect(o.range[0]).toMatchObject({ title: "Dishes" });
    const choreCalls = calls.filter((c) => new URL(c.url).pathname.endsWith("/chores"));
    expect(choreCalls).toHaveLength(1);
    const q = new URL(choreCalls[0]!.url).searchParams;
    expect([q.get("after"), q.get("before")]).toEqual(["2037-03-01", "2037-03-07"]);
  });

  it("G3. an occurrence of a repeating chore reports its own day, not the series start", () => {
    const { out } = runImporter(
      `
      const sky = lib.createSkylight({ frameId: "123", timezone: "America/Los_Angeles", credential: { token: "t" } });
      return await sky.chores.list({ from: "2037-03-01", to: "2037-03-07" });`,
      fixtures({
        "/chores": {
          data: [
            { id: "555-2037-03-04-0800", type: "chore", attributes: { summary: "Feed cat", status: "pending", start: "2037-01-01", recurring: true, routine: true }, relationships: {} },
            { id: "555-2037-03-05-0800", type: "chore", attributes: { summary: "Feed cat", status: "pending", start: "2037-01-01", recurring: true, routine: true }, relationships: {} },
            { id: "9", type: "chore", attributes: { summary: "Dishes", status: "pending", start: "2037-03-02", recurring: false }, relationships: {} },
          ],
          included: [],
        },
      })
    );
    expect((out as Array<{ date: string }>).map((c) => c.date)).toEqual(["2037-03-04", "2037-03-05", "2037-03-02"]);
  });

  it("G4. a refreshed credential that cannot be saved ends the call with CredentialSaveError and no store text", () => {
    const { out } = runImporter(
      `
      const store = {
        name: "broken-writes",
        read: async () => ({ version: 1, type: "oauth", accessToken: "AT-old", refreshToken: "RT-old", fingerprint: "f", expiresAt: Date.now() - 1000 }),
        write: async (c) => { throw new Error("quota exceeded " + JSON.stringify(c)); },
        delete: async () => true,
      };
      const sky = lib.createSkylight({ frameId: "123", timezone: "America/Los_Angeles", credential: store });
      try { await sky.profiles.list(); return { ok: true }; }
      catch (e) { return { name: e.name, code: e.code, message: String(e.message) }; }`,
      fixtures({ "/oauth/token": { access_token: "AT-new-1", refresh_token: "RT-new-1", expires_in: 3600 } })
    );
    expect(out).toMatchObject({ name: "CredentialSaveError", code: "CREDENTIAL_SAVE_FAILED" });
    const message = (out as { message: string }).message;
    for (const bit of ["quota exceeded", "AT-new-1", "RT-new-1", "RT-old"]) expect(message).not.toContain(bit);
  });
});

// ---------------------------------------------------------------------------
// Setup-only entry (@davidwoods/skylight-mcp/setup): the browser-paste sign-in for an importer's own store.

const AT = "AT-secret-1";
const RT = "RT-secret-1";
const CODE = "CODE-secret-1";
const tokenOk = { "/oauth/token": { access_token: AT, refresh_token: RT, expires_in: 3600 } };

const SETUP_PRELUDE = `import * as setup from "${PKG}/setup";
import { createHash } from "node:crypto";
const pendingStore = () => { let v = null; let takes = 0; return { save: async (x) => { v = x; }, take: async () => { takes++; const x = v; v = null; return x; }, peek: () => v, set: (x) => { v = x; }, takes: () => takes }; };
const credStore = (failWrite = false) => { let c = null; let writes = 0; return { name: "mem", read: async () => c, write: async (x) => { if (failWrite) throw new Error("disk full " + JSON.stringify(x)); c = x; writes++; }, delete: async () => { const had = !!c; c = null; return had; }, get: () => c, writes: () => writes }; };
const begin = async () => { const pending = pendingStore(); const started = await setup.beginLogin({ pending }); const record = JSON.parse(pending.peek()); return { pending, started, record, state: new URL(started.loginUrl).searchParams.get("state") }; };
const redirectFor = (state, code = "${CODE}") => "https://ourskylight.com/welcome?code=" + code + "&state=" + state;
const attempt = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { name: e?.name, code: e?.code, message: String(e?.message) }; } };`;

const runSetup = (body: string, fx: Record<string, unknown> = tokenOk) => runImporter(body, fx, [], SETUP_PRELUDE);

describe("setup entry, from the importer's side (packed package)", () => {
  it("S1. the setup entry exports exactly three functions; the root is unchanged; internals stay closed", () => {
    const { out } = runSetup(`
      const deep = await attempt(() => import("${PKG}/dist/api/oauth.js"));
      const deep2 = await attempt(() => import("${PKG}/dist/setup.js"));
      return { setup: Object.keys(setup).sort(), root: Object.keys(lib).sort(), deep: deep.code, deep2: deep2.code };`);
    expect(out).toEqual({ setup: ["beginLogin", "completeLogin", "loginStatus"], root: ["createSkylight"], deep: "ERR_PACKAGE_PATH_NOT_EXPORTED", deep2: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  });

  it("S2. a full sign-in returns no secret, uses PKCE S256, talks only to the pinned host, and the stored credential works", () => {
    const { out, calls } = runSetup(
      `
      const { pending, started, record, state } = await begin();
      const login = new URL(started.loginUrl);
      const credential = credStore();
      const done = await setup.completeLogin({ pending, credential, redirectUrl: redirectFor(state) });
      const status = await setup.loginStatus({ credential });
      const sky = lib.createSkylight({ frameId: "123", timezone: "America/Los_Angeles", credential });
      await sky.calendar.sources();
      return {
        returned: JSON.stringify([started, done, status]),
        loginHost: login.host, method: login.searchParams.get("code_challenge_method"),
        challengeOk: login.searchParams.get("code_challenge") === createHash("sha256").update(record.codeVerifier).digest("base64url"),
        verifier: record.codeVerifier, done, status, stored: credential.get(), pendingLeft: pending.peek(),
      };`,
      { ...tokenOk, "/source_calendars": { data: [] } }
    );
    const o = out as { returned: string; loginHost: string; method: string; challengeOk: boolean; verifier: string; done: Record<string, unknown>; status: Record<string, unknown>; stored: { accessToken: string; refreshToken: string }; pendingLeft: unknown };
    expect(o.loginHost).toBe("app.ourskylight.com");
    expect(o.method).toBe("S256");
    expect(o.challengeOk).toBe(true);
    for (const secret of [AT, RT, CODE, o.verifier]) expect(o.returned).not.toContain(secret);
    expect(Object.keys(o.done).sort()).toEqual(["expiresAt", "signedIn"]);
    expect(Object.keys(o.status).sort()).toEqual(["expired", "expiresAt", "signedIn"]);
    expect(o.status).toMatchObject({ signedIn: true, expired: false });
    expect(o.stored).toMatchObject({ accessToken: AT, refreshToken: RT });
    expect(o.pendingLeft).toBeNull();
    // One token exchange, then the client's own reads (a subscription check and the sources call).
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c.host).toBe("app.ourskylight.com");
    expect(calls.filter((c) => c.url.includes("/oauth/")).length).toBe(1);
    expect(calls[0]!.url).toBe("https://app.ourskylight.com/oauth/token");
    expect(calls[0]!.method).toBe("POST");
    const sent = new URLSearchParams(calls[0]!.body ?? "");
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe(CODE);
    expect(sent.get("code_verifier")).toBe(o.verifier);
    for (const c of calls.slice(1)) expect(c.auth).toBe(`Bearer ${AT}`);
    expect(calls[calls.length - 1]!.url).toContain("/source_calendars");
  });

  it("S3. any address that is not the pinned Skylight redirect is refused before any request, and never echoed", () => {
    const { out, calls } = runSetup(`
      const { pending, state } = await begin();
      const credential = credStore();
      const q = "?code=${CODE}&state=" + state;
      const hostile = [
        "https://evil.example/welcome" + q,
        "https://ourskylight.com.evil.example/welcome" + q,
        "https://ourskylight.com/other" + q,
        "https://user:hunter2@ourskylight.com/welcome" + q,
        "http://ourskylight.com/welcome" + q,
        "https://ourskylight.com:8443/welcome" + q,
        "https://app.ourskylight.com/welcome" + q,
        "webcal://feeds.example.com/SECRETFEED/cal.ics",
        "not a url " + state,
        5,
      ];
      const results = [];
      for (const redirectUrl of hostile) results.push(await attempt(() => setup.completeLogin({ pending, credential, redirectUrl })));
      const stillWorks = await attempt(() => setup.completeLogin({ pending, credential: credStore(), redirectUrl: redirectFor(state) }));
      return { results, writes: credential.writes(), takes: pending.takes(), stillWorks: stillWorks.ok?.signedIn, state };`);
    const o = out as { results: Array<{ name: string; code: string; message: string }>; writes: number; takes: number; stillWorks: boolean; state: string };
    expect(o.results.length).toBe(10);
    for (const r of o.results) {
      expect(r).toMatchObject({ name: "SkylightSetupError", code: "bad_redirect_url" });
      for (const bit of ["evil.example", "hunter2", "SECRETFEED", CODE, o.state, "8443"]) expect(r.message).not.toContain(bit);
    }
    expect(o.writes).toBe(0);
    // A mistyped paste does not burn the pending login: the right address still works afterwards.
    expect(o.stillWorks).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("S4. a wrong state, a replay and an expired attempt are each refused, with no request and nothing stored", () => {
    const { out, calls } = runSetup(`
      const credential = credStore();
      const a = await begin();
      const wrongState = await attempt(() => setup.completeLogin({ pending: a.pending, credential, redirectUrl: redirectFor("0".repeat(32)) }));
      const afterWrongState = await attempt(() => setup.completeLogin({ pending: a.pending, credential, redirectUrl: redirectFor(a.state) }));
      const b = await begin();
      const old = { ...b.record, createdAt: Date.now() - 11 * 60 * 1000 };
      b.pending.set(JSON.stringify(old));
      const expired = await attempt(() => setup.completeLogin({ pending: b.pending, credential, redirectUrl: redirectFor(b.state) }));
      const none = await attempt(() => setup.completeLogin({ pending: pendingStore(), credential, redirectUrl: redirectFor(a.state) }));
      const junk = pendingStore(); junk.set("{not json");
      const garbled = await attempt(() => setup.completeLogin({ pending: junk, credential, redirectUrl: redirectFor(a.state) }));
      return { codes: [wrongState.code, afterWrongState.code, expired.code, none.code, garbled.code], writes: credential.writes(),
        messages: [wrongState, afterWrongState, expired, none, garbled].map((r) => r.message).join(" | "), secrets: [a.state, b.state, a.record.codeVerifier, b.record.codeVerifier] };`);
    const o = out as { codes: string[]; writes: number; messages: string; secrets: string[] };
    expect(o.codes).toEqual(["state_mismatch", "no_pending_login", "expired", "no_pending_login", "no_pending_login"]);
    expect(o.writes).toBe(0);
    for (const s of [...o.secrets, CODE]) expect(o.messages).not.toContain(s);
    expect(calls).toEqual([]);
  });

  it("S4b. a pending login works exactly once", () => {
    const { out, calls } = runSetup(`
      const { pending, state } = await begin();
      const first = await attempt(() => setup.completeLogin({ pending, credential: credStore(), redirectUrl: redirectFor(state) }));
      const second = await attempt(() => setup.completeLogin({ pending, credential: credStore(), redirectUrl: redirectFor(state) }));
      return [first.ok?.signedIn, second.code];`);
    expect(out).toEqual([true, "no_pending_login"]);
    expect(calls.length).toBe(1);
  });

  it("S5. when Skylight refuses, the error is our own words: no response text, code, verifier or token", () => {
    const { out, calls } = runSetup(
      `
      const { pending, state, record } = await begin();
      const credential = credStore();
      const refused = await attempt(() => setup.completeLogin({ pending, credential, redirectUrl: redirectFor(state) }));
      return { refused, writes: credential.writes(), verifier: record.codeVerifier, state };`,
      { "/oauth/token": { __status: 400, error: "invalid_grant", echoed: `${CODE} ${RT} LEAKY-BODY` } }
    );
    const o = out as { refused: { code: string; message: string }; writes: number; verifier: string; state: string };
    expect(o.refused.code).toBe("skylight_refused");
    for (const bit of ["LEAKY-BODY", "invalid_grant", CODE, RT, o.verifier, o.state]) expect(o.refused.message).not.toContain(bit);
    expect(o.writes).toBe(0);
    expect(calls.length).toBe(1);
  });

  it("S6. a failed save is not reported as signed in, and leaks nothing; status reads an empty store as signed out", () => {
    const { out } = runSetup(`
      const { pending, state } = await begin();
      const broken = credStore(true);
      const failed = await attempt(() => setup.completeLogin({ pending, credential: broken, redirectUrl: redirectFor(state) }));
      const empty = await setup.loginStatus({ credential: credStore() });
      return { failed, empty, stored: broken.get() };`);
    const o = out as { failed: { code: string; message: string; ok?: unknown }; empty: unknown; stored: unknown };
    expect(o.failed.ok).toBeUndefined();
    expect(o.failed.code).toBe("store_failed");
    for (const bit of [AT, RT, "disk full"]) expect(o.failed.message).not.toContain(bit);
    expect(o.empty).toEqual({ signedIn: false, expired: false, expiresAt: null });
    expect(o.stored).toBeNull();
  });

  it("S7. unknown options are refused (no host, base URL or fetch), and the types offer none", () => {
    const { out, calls } = runSetup(`
      const { pending, state } = await begin();
      const credential = credStore();
      const r = [
        await attempt(() => setup.beginLogin({ pending, baseUrl: "https://evil.example" })),
        await attempt(() => setup.completeLogin({ pending, credential, redirectUrl: redirectFor(state), fetch: () => {} })),
        await attempt(() => setup.completeLogin({ pending, credential, redirectUrl: redirectFor(state), host: "evil.example" })),
        await attempt(() => setup.loginStatus({ credential, apiBase: "https://evil.example" })),
        await attempt(() => setup.completeLogin({ pending: {}, credential, redirectUrl: redirectFor(state) })),
        await attempt(() => setup.completeLogin({ pending, credential: { token: "x" }, redirectUrl: redirectFor(state) })),
      ];
      return { codes: r.map((x) => x.code), writes: credential.writes(), takes: pending.takes() };`);
    expect(out).toEqual({ codes: Array(6).fill("bad_options"), writes: 0, takes: 0 });
    expect(calls).toEqual([]);
    const dts = fs.readFileSync(path.join(proj, "node_modules", "@davidwoods", "skylight-mcp", "dist", "setup.d.ts"), "utf8");
    const declarations = dts.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const word of ["baseUrl", "fetch", "host", "accessToken", "refreshToken", "codeVerifier"]) expect(declarations).not.toContain(word);
  });
});
