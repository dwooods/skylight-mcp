// Live check of the library's meal writes on a REPEATING meal, against your own frame. Run after `npm run build`:
//   node scripts/meal-series-live-check.mjs
// WRITES to the frame, then undoes itself. Creates ONE throwaway weekly series (ZZ library series, Dinner, Mondays from
// 2027-03-01, unassigned) and walks it through: edit one day (scope one), edit that detached day, edit this-and-later
// (scope future), edit a whole series (scope all), delete the detached day, delete this-and-later, delete the rest.
// Each step is read back and the other days are checked to be untouched. A failure runs a cleanup that deletes whatever
// is left with that title from 2027-03-01 to 2027-06-30. Prints step results only: no ids, no stored text.
import { createSkylight } from "../dist/lib.js";
import { defaultCredentialStore } from "../dist/api/credential-store.js";
import { readConfigFile } from "../dist/config-file.js";

const TITLE = "ZZ library series";
const D1 = "2027-03-01", D2 = "2027-03-08", D3 = "2027-03-15", D4 = "2027-03-22", D5 = "2027-03-29";
const cfg = await readConfigFile();
if (!cfg) { console.error("No settings file. Run `skylight-mcp init` first."); process.exit(2); }
const sk = createSkylight({ frameId: cfg.frameId, timezone: cfg.timezone, credential: defaultCredentialStore() });

let failed = 0;
const step = (name, ok, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ": " + extra : ""}`); if (!ok) failed++; return ok; };
const stop = () => { throw new Error("stop"); };
const must = (name, ok, extra) => { if (!step(name, ok, extra)) stop(); };
const errInfo = (e) => `${e?.name ?? "Error"}${e?.code ? " code=" + e.code : ""}`;
const rows = async () => (await sk.meals.sittings({ from: D1, to: "2027-06-30" })).filter((m) => m.title === TITLE);
const at = (r, d) => r.find((m) => m.dates.includes(d));
const ref = (m, d) => ({ id: m.id, date: d, version: m.version });
const desc = (r, d) => at(r, d)?.description ?? null;
async function code(fn) { try { await fn(); return "no error"; } catch (e) { return e?.code ?? errInfo(e); } }

let started = false;
try {
  const dinner = (await sk.meals.categories()).find((c) => String(c.name).toLowerCase() === "dinner");
  must("Dinner category found", !!dinner);
  must("no meal with the test title from 2027-03-01 on", (await rows()).length === 0);

  const input = { title: TITLE, date: D1, category: String(dinner.id), description: "series created", repeat: "weekly" };
  started = true;
  const created = await sk.meals.create(input);
  let r = await rows();
  must("create: one weekly series, recurring, on all five March Mondays", r.length === 1 && created.recurring === true && [D1, D2, D3, D4, D5].every((d) => r[0].dates.includes(d)));

  const noScope = await code(() => sk.meals.previewUpdate({ ...ref(r[0], D2), changes: { description: "x" } }));
  step("a series update with no scope is refused", noScope === "scope_required", noScope);

  // 1. scope one on D2
  const p1 = await sk.meals.previewUpdate({ ...ref(r[0], D2), scope: "one", changes: { description: "one-day edit" } });
  step("previewUpdate scope one names the scope", p1.scope === "one");
  step("previewUpdate wrote nothing", desc(await rows(), D2) === "series created");
  const u1 = await sk.meals.update({ ...ref(r[0], D2), scope: "one", changes: { description: "one-day edit" } });
  r = await rows();
  const det = at(r, D2), ser = at(r, D1);
  must("scope one: D2 is its own detached meal with the edit, under a new id", !!det && det.detached === true && det.id !== ser?.id && det.id === u1.id && det.description === "one-day edit");
  step("scope one: the series lost only D2", !!ser && ser.detached === false && ser.dates.includes(D1) && ser.dates.includes(D3) && !ser.dates.includes(D2) && ser.description === "series created");

  // 2. edit the detached day
  const scoped = await code(() => sk.meals.previewUpdate({ ...ref(det, D2), scope: "one", changes: { description: "x" } }));
  step("a detached meal refuses a scope", scoped === "scope_not_allowed", scoped);
  const u2 = await sk.meals.update({ ...ref(det, D2), changes: { description: "detached edit" } });
  r = await rows();
  step("detached edit keeps its id and changes only D2", u2.id === det.id && desc(r, D2) === "detached edit" && desc(r, D1) === "series created" && desc(r, D3) === "series created");
  step("the detached meal refuses a move", (await code(() => sk.meals.previewUpdate({ ...ref(at(r, D2), D2), changes: { date: D4 } }))) === "unsupported");

  // 3. scope future on D3
  const sa = at(r, D3);
  const u3 = await sk.meals.update({ ...ref(sa, D3), scope: "future", changes: { description: "future edit" } });
  r = await rows();
  const later = at(r, D3), first = at(r, D1);
  must("scope future: D3 onward is a new series with the edit", !!later && later.id !== first?.id && later.id === u3.id && [D3, D4, D5].every((d) => later.dates.includes(d) && desc(r, d) === "future edit"));
  step("scope future: D1 and the detached D2 are untouched", desc(r, D1) === "series created" && desc(r, D2) === "detached edit" && at(r, D2).detached === true && !first.dates.includes(D3));

  // 4. scope all on the later series
  const u4 = await sk.meals.update({ ...ref(at(r, D4), D4), scope: "all", changes: { description: "all edit" } });
  r = await rows();
  step("scope all: the whole later series changed, same id", u4.id === later.id && [D3, D4, D5].every((d) => desc(r, d) === "all edit"));
  step("scope all: D1 and D2 are untouched", desc(r, D1) === "series created" && desc(r, D2) === "detached edit");

  // 5. deletes
  const dd = await sk.meals.delete(ref(at(r, D2), D2));
  r = await rows();
  step("delete of the detached day: gone, others stay", dd.deleted === true && !at(r, D2) && !!at(r, D1) && !!at(r, D3));
  const df = await sk.meals.delete({ ...ref(at(r, D4), D4), scope: "future" });
  r = await rows();
  step("delete scope future from D4: D3 stays, D4 on gone", df.scope === "future" && !!at(r, D3) && !at(r, D4) && !at(r, D5) && !!at(r, D1));
  const da = await sk.meals.delete({ ...ref(at(r, D3), D3), scope: "all" });
  r = await rows();
  step("delete scope all on the later series: D3 gone, D1 stays", da.scope === "all" && !at(r, D3) && !!at(r, D1));
  await sk.meals.delete({ ...ref(at(r, D1), D1), scope: "all" });
  step("delete scope all on the first series: nothing left", (await rows()).length === 0);
} catch (e) {
  if (e?.message !== "stop") step("unexpected error", false, errInfo(e));
} finally {
  if (started) {
    let left = [];
    try {
      for (let i = 0; i < 5; i++) {
        left = await rows();
        if (left.length === 0) break;
        const m = left[0];
        const d = [...m.dates].sort()[0];
        await sk.meals.delete(m.detached || !m.recurring ? ref(m, d) : { ...ref(m, d), scope: "all" });
      }
      left = await rows();
      if (left.length > 0 || failed > 0) step("cleanup", left.length === 0, left.length ? `${left.length} meal(s) left: delete "${TITLE}" from 2027-03-01 in the app` : "nothing left");
    } catch (e) { step("cleanup", false, `${errInfo(e)}; delete "${TITLE}" from 2027-03-01 in the app`); }
  }
}
console.log(failed === 0 ? "\nPASS: every scope matched on an independent read and left the other days alone." : `\nFAIL: ${failed} step(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
