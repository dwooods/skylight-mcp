// READ-ONLY live check of the library's meal `profiles` read on a meal assigned to someone. Run after `npm run build`:
//   node scripts/meal-profiles-live-check.mjs
// First create the meal in the Skylight app: title "ZZ profile test", Dinner, Monday 2027-03-01, assigned to ONE person.
// This script only reads. It prints pass/fail lines and counts, never names, ids or text.
import { createSkylight } from "../dist/lib.js";
import { defaultCredentialStore } from "../dist/api/credential-store.js";
import { readConfigFile } from "../dist/config-file.js";

const TITLE = "ZZ profile test", DATE = "2027-03-01";
const cfg = await readConfigFile();
if (!cfg) { console.error("No settings file. Run `skylight-mcp init` first."); process.exit(2); }
const sk = createSkylight({ frameId: cfg.frameId, timezone: cfg.timezone, credential: defaultCredentialStore() });
let failed = 0;
const step = (name, ok, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ": " + extra : ""}`); if (!ok) failed++; return ok; };

const meals = (await sk.meals.sittings({ from: DATE, to: DATE })).filter((m) => m.title === TITLE);
if (!step("exactly one meal with the test title on the day", meals.length === 1, `${meals.length} found; create it in the app first`)) process.exit(1);
const m = meals[0];
const people = await sk.profiles.list();
const byId = new Map(people.map((p) => [String(p.id), p]));
step("assigned to exactly one person", m.profileIds.length === 1 && m.profiles.length === 1, `${m.profileIds.length} ids, ${m.profiles.length} names`);
step("the id is a known profile and the name matches profiles.list()", m.profileIds.length === 1 && byId.has(String(m.profileIds[0])) && m.profiles[0] === byId.get(String(m.profileIds[0]))?.label);
step("not marked detached, one-off", m.detached === false && m.recurring === false);
step("version is a 16-hex fingerprint", /^[0-9a-f]{16}$/.test(m.version));
const unassigned = (await sk.meals.sittings({ from: DATE, to: DATE })).filter((x) => x.title !== TITLE).length;
console.log(`info  other meals on the day: ${unassigned}`);
console.log(failed === 0 ? "\nPASS: the profiles read matched profiles.list() for a real assigned meal." : `\nFAIL: ${failed} step(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
