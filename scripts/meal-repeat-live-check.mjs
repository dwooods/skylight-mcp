// Live check of meal repeats with Skylight's full options, through the library, against your own frame.
// Run after `npm run build`:
//   node scripts/meal-repeat-live-check.mjs
// WRITES to the frame, then undoes itself. Creates throwaway series titled "ZZ repeat check …" (Dinner, unassigned,
// Jan to Aug 2027): every 2 weeks on Mon+Wed until Apr 28, then moves its end to Mar 31 and removes the end, each
// with scope "all", checking that every earlier day stays exactly as it was; then a monthly 1st-Monday series, a daily
// series with an end and a yearly one. Then two rules whose skipped months come from our own date model, not from a
// capture: monthly on the 31st (Jan 31 to Jun 30, expects Jan 31, Mar 31, May 31) and monthly on the 5th Monday
// (Mar 29 to Aug 31, expects Mar 29, May 31, Aug 30). A difference there is a finding about Skylight, not a bug in
// this script: it means the preview's dates and the skips_months notice describe something Skylight does not do.
// Each is compared with the preview's dates, then deleted (scope "all").
// A failure runs a cleanup that deletes anything left with that title prefix from 2027-01-01 to 2027-09-30.
// Prints step results only: no ids, no stored text.
import { createSkylight } from "../dist/lib.js";
import { defaultCredentialStore } from "../dist/api/credential-store.js";
import { readConfigFile } from "../dist/config-file.js";

const PREFIX = "ZZ repeat check";
const FROM = "2027-01-01", TO = "2027-09-30";
const cfg = await readConfigFile();
if (!cfg) { console.error("No settings file. Run `skylight-mcp init` first."); process.exit(2); }
const sk = createSkylight({ frameId: cfg.frameId, timezone: cfg.timezone, credential: defaultCredentialStore() });

let failed = 0;
const step = (name, ok, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ": " + extra : ""}`); if (!ok) failed++; return ok; };
const must = (name, ok, extra) => { if (!step(name, ok, extra)) throw new Error("stop"); };
const errInfo = (e) => `${e?.name ?? "Error"}${e?.code ? " code=" + e.code : ""}`;
const mine = async (title) => (await sk.meals.sittings({ from: FROM, to: TO })).filter((m) => (title ? m.title === title : String(m.title ?? "").startsWith(PREFIX)));
const days = (list) => list.flatMap((m) => m.dates).sort();
// Compare values, not key order: { a, b } and { b, a } are the same rule.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const within = (list, last) => list.filter((d) => d <= last);

let started = false;
try {
  const dinner = (await sk.meals.categories()).find((c) => String(c.name).toLowerCase() === "dinner");
  must("Dinner category found", !!dinner);
  must(`nothing titled "${PREFIX}…" from ${FROM} to ${TO}`, (await mine()).length === 0);
  const cat = String(dinner.id);

  // 1. every 2 weeks on Mon + Wed, until Apr 28
  const T1 = `${PREFIX} B`;
  const input = { title: T1, date: "2027-03-01", category: cat, repeat: { every: "week", interval: 2, weekdays: ["MO", "WE"], until: "2027-04-28" } };
  const p1 = await sk.meals.previewCreate(input);
  step("preview: rule as asked, first five and last dates", same(p1.repeat, { every: "week", interval: 2, weekdays: ["MO", "WE"], until: "2027-04-28" }) && p1.occurrences.first.length === 5 && p1.occurrences.last === "2027-04-28");
  started = true;
  const c1 = await sk.meals.create(input);
  let r = await mine(T1);
  must("create: one series, stored rule read back as asked", r.length === 1 && same(r[0].repeat, p1.repeat) && same(c1.repeat, p1.repeat));
  const all1 = days(r);
  step("the days Skylight stored start with the preview's first five", same(all1.slice(0, 5), p1.occurrences.first), all1.slice(0, 5).join(" "));
  step("the last stored day is the preview's last", all1[all1.length - 1] === p1.occurrences.last, all1[all1.length - 1]);
  const before = r[0];

  // 2. move the end earlier (scope all), every earlier day exactly as it was
  const pu = await sk.meals.previewUpdate({ id: before.id, date: "2027-03-15", version: before.version, scope: "all", changes: { repeat: { every: "week", interval: 2, weekdays: ["MO", "WE"], until: "2027-03-31" } } });
  step("preview of the new end names it and the last day", pu.changes.repeat?.until === "2027-03-31" && pu.occurrences?.last === "2027-03-31");
  step("preview wrote nothing", same(days(await mine(T1)), all1));
  const u2 = await sk.meals.update({ id: before.id, date: "2027-03-15", version: before.version, scope: "all", changes: { repeat: { every: "week", interval: 2, weekdays: ["MO", "WE"], until: "2027-03-31" } } });
  r = await mine(T1);
  step("end moved: same id, one series, rule ends Mar 31", r.length === 1 && r[0].id === before.id && u2.id === before.id && r[0].repeat?.until === "2027-03-31");
  step("every day up to Mar 31 is exactly as before, none after", same(days(r), within(all1, "2027-03-31")), days(r).join(" "));
  step("title, category, people, text unchanged", r[0].title === before.title && r[0].category === before.category && same(r[0].profileIds, before.profileIds) && r[0].description === before.description && r[0].note === before.note);

  // 3. remove the end (scope all)
  const u3 = await sk.meals.update({ id: r[0].id, date: "2027-03-01", version: r[0].version, scope: "all", changes: { repeat: { every: "week", interval: 2, weekdays: ["MO", "WE"] } } });
  r = await mine(T1);
  step("end removed: same id, open-ended", r.length === 1 && r[0].id === before.id && u3.id === before.id && r[0].repeat?.until === null);
  step("days up to Apr 28 are the original ones again, and it continues past", same(within(days(r), "2027-04-28"), all1) && days(r).some((d) => d > "2027-04-28"));

  // 4. monthly on the 1st Monday, daily with an end, yearly
  const more = [
    { title: `${PREFIX} C2`, repeat: { every: "month", monthlyOn: "weekday" }, want: { every: "month", interval: 1, monthlyOn: "weekday", until: null } },
    { title: `${PREFIX} D1`, repeat: { every: "day", until: "2027-03-03" }, want: { every: "day", interval: 1, until: "2027-03-03" } },
    { title: `${PREFIX} D2`, repeat: { every: "year" }, want: { every: "year", interval: 1, until: null } },
  ];
  for (const m of more) {
    const p = await sk.meals.previewCreate({ title: m.title, date: "2027-03-01", category: cat, repeat: m.repeat });
    await sk.meals.create({ title: m.title, date: "2027-03-01", category: cat, repeat: m.repeat });
    const got = await mine(m.title);
    const inWindow = p.occurrences.first.filter((d) => d <= TO);
    step(`${m.title.slice(PREFIX.length + 1)}: rule read back as asked, days match the preview`, got.length === 1 && same(got[0].repeat, m.want) && same(days(got).slice(0, inWindow.length), inWindow), days(got).join(" "));
  }

  // 4b. rules whose skipped months come from our date model: compare every stored day with the model's days
  const skip = [
    { title: `${PREFIX} E`, date: "2027-01-31", repeat: { every: "month", until: "2027-06-30" }, want: { every: "month", interval: 1, monthlyOn: "date", until: "2027-06-30" }, days: ["2027-01-31", "2027-03-31", "2027-05-31"] },
    { title: `${PREFIX} F`, date: "2027-03-29", repeat: { every: "month", monthlyOn: "weekday", until: "2027-08-31" }, want: { every: "month", interval: 1, monthlyOn: "weekday", until: "2027-08-31" }, days: ["2027-03-29", "2027-05-31", "2027-08-30"] },
  ];
  for (const m of skip) {
    const label = m.title.slice(PREFIX.length + 1);
    const p = await sk.meals.previewCreate({ title: m.title, date: m.date, category: cat, repeat: m.repeat });
    step(`${label}: preview dates are the model's`, same(p.occurrences.first, m.days) && p.occurrences.last === m.days[m.days.length - 1], p.occurrences.first.join(" "));
    await sk.meals.create({ title: m.title, date: m.date, category: cat, repeat: m.repeat });
    const got = await mine(m.title);
    step(`${label}: one series, rule read back as asked`, got.length === 1 && same(got[0].repeat, m.want));
    step(`${label}: Skylight stored exactly the model's days`, same(days(got), m.days), `stored ${days(got).join(" ") || "none"}; model ${m.days.join(" ")}`);
  }

  // 5. delete everything, whole series
  for (const m of await mine()) await sk.meals.delete({ id: m.id, date: [...m.dates].sort()[0], version: m.version, scope: "all" });
  step("all deleted (scope all), nothing left", (await mine()).length === 0);
} catch (e) {
  if (e?.message !== "stop") step("unexpected error", false, errInfo(e));
} finally {
  if (started) {
    try {
      for (let i = 0; i < 8; i++) {
        const left = await mine();
        if (left.length === 0) break;
        const m = left[0];
        const d = [...m.dates].sort()[0];
        await sk.meals.delete(m.detached || !m.recurring ? { id: m.id, date: d, version: m.version } : { id: m.id, date: d, version: m.version, scope: "all" });
      }
      const left = await mine();
      if (left.length > 0 || failed > 0) step("cleanup", left.length === 0, left.length ? `${left.length} left: delete "${PREFIX}…" meals from ${FROM} in the app` : "nothing left");
    } catch (e) { step("cleanup", false, `${errInfo(e)}; delete "${PREFIX}…" meals from ${FROM} in the app`); }
  }
}
console.log(failed === 0 ? "\nPASS: repeat options created, end moved and removed with earlier days untouched, all read back and deleted." : `\nFAIL: ${failed} step(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
