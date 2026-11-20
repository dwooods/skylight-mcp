// Live check of `profileIds` on the library's meal create and update. Run after `npm run build`:
//   node scripts/meal-profileids-live-check.mjs <profile label> [<second profile label>]
// WRITES to the frame, then undoes itself. Creates ONE throwaway one-off meal (ZZ profileIds test, Dinner, 2027-03-01)
// assigned to the profile you name, unassigns it, assigns it again (and to a second profile if you give one), tries
// an unknown profile id, and deletes it. Each step is read back. A failure runs a cleanup delete.
// Profile labels come from the command line so no family name lives in the repo. Prints step results only.
import { createSkylight } from "../dist/lib.js";
import { defaultCredentialStore } from "../dist/api/credential-store.js";
import { readConfigFile } from "../dist/config-file.js";

const TITLE = "ZZ profileIds test", DATE = "2027-03-01";
const [labelA, labelB] = process.argv.slice(2);
if (!labelA) { console.error("Usage: node scripts/meal-profileids-live-check.mjs <profile label> [<second profile label>]"); process.exit(2); }
const cfg = await readConfigFile();
if (!cfg) { console.error("No settings file. Run `skylight-mcp init` first."); process.exit(2); }
const sk = createSkylight({ frameId: cfg.frameId, timezone: cfg.timezone, credential: defaultCredentialStore() });

let failed = 0;
const step = (name, ok, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ": " + extra : ""}`); if (!ok) failed++; return ok; };
const must = (name, ok, extra) => { if (!step(name, ok, extra)) throw new Error("stop"); };
const errInfo = (e) => `${e?.name ?? "Error"}${e?.code ? " code=" + e.code : ""}`;
const rows = async () => (await sk.meals.sittings({ from: DATE, to: DATE })).filter((m) => m.title === TITLE);
const same = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

let ref = null;
try {
  const people = await sk.profiles.list();
  const find = (l) => people.filter((p) => p.label.toLowerCase() === l.toLowerCase());
  must(`profile "${labelA}" found exactly once`, find(labelA).length === 1);
  if (labelB) must(`second profile found exactly once`, find(labelB).length === 1 && find(labelB)[0].id !== find(labelA)[0].id);
  const A = String(find(labelA)[0].id), B = labelB ? String(find(labelB)[0].id) : null;
  const dinner = (await sk.meals.categories()).find((c) => String(c.name).toLowerCase() === "dinner");
  must("Dinner category found", !!dinner);
  must("no meal with the test title on the day yet", (await rows()).length === 0);

  const input = { title: TITLE, date: DATE, category: String(dinner.id), profileIds: [A] };
  const pc = await sk.meals.previewCreate(input);
  step("previewCreate lists one person and wrote nothing", pc.profileIds.length === 1 && pc.profiles.length === 1 && (await rows()).length === 0);
  const created = await sk.meals.create(input);
  ref = { id: created.id, date: DATE, version: created.version };
  let r = await rows();
  must("create: stored with that person, one meal on the day", r.length === 1 && same(created.profileIds, [A]) && same(r[0].profileIds, [A]) && r[0].profiles.length === 1);

  const step2 = async (name, profileIds) => {
    const changes = { profileIds };
    const p = await sk.meals.previewUpdate({ ...ref, changes });
    const nothing = same((await rows())[0].profileIds, JSON.parse(JSON.stringify(r[0].profileIds)));
    const u = await sk.meals.update({ ...ref, changes });
    ref = { id: u.id, date: DATE, version: u.version };
    r = await rows();
    step(`${name}: preview wrote nothing, update stored it, re-read matches`, nothing && Array.isArray(p.changes.profileIds) && same(u.profileIds, profileIds) && r.length === 1 && same(r[0].profileIds, profileIds) && r[0].title === TITLE);
  };
  await step2("unassign (empty list)", []);
  await step2("assign again", [A]);
  if (B) await step2("assign two people", [A, B]);

  let bad = null;
  try { await sk.meals.previewUpdate({ ...ref, changes: { profileIds: ["999999999"] } }); } catch (e) { bad = e; }
  step("an unknown profile id is refused as unknown_profile", bad?.code === "unknown_profile", bad ? errInfo(bad) : "no error thrown");
  step("the refusal changed nothing", same((await rows())[0].profileIds, r[0].profileIds));

  const del = await sk.meals.delete(ref);
  ref = null;
  step("delete reports deleted", del.deleted === true);
  step("independent read: gone", (await rows()).length === 0);
} catch (e) {
  if (e?.message !== "stop") step("unexpected error", false, errInfo(e));
} finally {
  if (ref) {
    try {
      const cur = (await rows())[0];
      if (cur) await sk.meals.delete({ id: cur.id, date: DATE, version: cur.version });
      step("cleanup after a failure", (await rows()).length === 0);
    } catch (e) { step("cleanup after a failure", false, `${errInfo(e)}; delete "${TITLE}" on ${DATE} in the app`); }
  }
}
console.log(failed === 0 ? "\nPASS: profileIds on create and update matched on an independent read." : `\nFAIL: ${failed} step(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
