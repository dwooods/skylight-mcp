// Live check of the library's meal writes against your own frame. Run from the clone after `npm run build`:
//   node scripts/meal-writes-live-check.mjs
// WRITES to the frame, then undoes itself: creates ONE throwaway one-off meal (ZZ library test, Dinner,
// 2027-03-01, unassigned), edits its description and note, deletes it, and reads each step back.
// If a step fails after the create, it tries to delete the meal and says whether that worked.
// Prints step results and counts only: no ids, no stored text, nothing to redact before pasting.
import { createSkylight } from "../dist/lib.js";
import { defaultCredentialStore } from "../dist/api/credential-store.js";
import { readConfigFile } from "../dist/config-file.js";

const TITLE = "ZZ library test";
const DATE = "2027-03-01";
const cfg = await readConfigFile();
if (!cfg) { console.error("No settings file. Run `skylight-mcp init` first."); process.exit(2); }
const sk = createSkylight({ frameId: cfg.frameId, timezone: cfg.timezone, credential: defaultCredentialStore() });

let failed = 0;
const step = (name, ok, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ": " + extra : ""}`); if (!ok) failed++; return ok; };
const errInfo = (e) => `${e?.name ?? "Error"}${e?.code ? " code=" + e.code : ""}`;
const onDay = async () => (await sk.meals.sittings({ from: DATE, to: DATE })).filter((m) => m.title === TITLE);

let ref = null; // { id, date, version } of the meal we made, for cleanup
try {
  const cats = await sk.meals.categories();
  const dinner = cats.find((c) => String(c.name).toLowerCase() === "dinner");
  if (!step("Dinner category found", !!dinner)) throw new Error("stop");
  const before = await onDay();
  if (!step("no meal with the test title on the day yet", before.length === 0, `${before.length} found`)) throw new Error("stop");

  const input = { title: TITLE, date: DATE, category: String(dinner.id), description: "created by the live check", note: "note from the live check" };
  const pc = await sk.meals.previewCreate(input);
  step("previewCreate names Dinner, no repeat, no people", pc.category.name.toLowerCase() === "dinner" && pc.repeat === null && pc.profileIds.length === 0);
  step("previewCreate wrote nothing", (await onDay()).length === 0);

  const created = await sk.meals.create(input);
  ref = { id: created.id, date: DATE, version: created.version };
  step("create returned the stored meal", created.title === TITLE && created.description === input.description && created.note === input.note && created.detached === false);
  const one = await onDay();
  step("independent read finds exactly one", one.length === 1 && one[0].id === created.id);

  const changes = { description: "edited by the live check", note: "edited note" };
  const pu = await sk.meals.previewUpdate({ ...ref, changes });
  step("previewUpdate: no scope, describes the change", pu.scope === null && pu.changes.description === changes.description);
  step("previewUpdate wrote nothing", (await onDay())[0]?.description === input.description);
  const updated = await sk.meals.update({ ...ref, changes });
  ref = { id: updated.id, date: DATE, version: updated.version };
  step("update returned the stored meal", updated.description === changes.description && updated.note === changes.note && updated.title === TITLE);
  const after = await onDay();
  step("independent read shows the edit", after.length === 1 && after[0].description === changes.description && after[0].note === changes.note);

  let stale = null;
  try { await sk.meals.update({ id: ref.id, date: DATE, version: created.version, changes: { description: "should not be written" } }); } catch (e) { stale = e; }
  step("an old version is refused as stale", stale?.code === "stale", stale ? errInfo(stale) : "no error thrown");

  const pd = await sk.meals.previewDelete(ref);
  step("previewDelete: no scope", pd.scope === null);
  step("previewDelete deleted nothing", (await onDay()).length === 1);
  const del = await sk.meals.delete(ref);
  step("delete reports deleted", del.deleted === true && del.scope === null);
  ref = null;
  step("independent read: gone", (await onDay()).length === 0);
} catch (e) {
  if (e?.message !== "stop") step("unexpected error", false, errInfo(e));
} finally {
  if (ref) {
    try {
      const cur = (await onDay())[0];
      if (cur) await sk.meals.delete({ id: cur.id, date: DATE, version: cur.version });
      step("cleanup after a failure", (await onDay()).length === 0);
    } catch (e) { step("cleanup after a failure", false, `${errInfo(e)}; delete "${TITLE}" on ${DATE} in the app`); }
  }
}
console.log(failed === 0 ? "\nPASS: create, edit, stale check and delete all matched on an independent read." : `\nFAIL: ${failed} step(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
