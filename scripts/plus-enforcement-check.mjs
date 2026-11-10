// Does Skylight enforce Plus on its servers for a FREE account? Maintainer probe, not in the npm package.
// Run ONLY against a throwaway free account, from the clone after `npm run build`:
//   node scripts/plus-enforcement-check.mjs --frame=<the test frame's id>
// Before running, make sure the browser is signed in to the TEST account, not the family one.
// It makes a new sign-in held in memory only: nothing is written to the Keychain or the settings
// file, so the family sign-in is untouched. It prints route, status and verdict for each check,
// never response data. The writes create one test record each and delete it straight after.
import { beginLogin, completeLogin } from "../dist/setup.js";
import { promptHidden } from "../dist/prompt-hidden.js";
import { openSkylightUrl } from "../dist/open-url.js";
import { SkylightClient, setQuietRequestLog } from "../dist/api/client.js";
import { runWithContext } from "../dist/context.js";
import { getCalendarEvents, createCalendarEvent, deleteCalendarEvent, dinnerPlanEvent } from "../dist/api/endpoints/calendar.js";
import { getLists } from "../dist/api/endpoints/lists.js";
import { getChores } from "../dist/api/endpoints/chores.js";
import { getCategories } from "../dist/api/endpoints/categories.js";
import { getMealCategories, getMealSittings, getRecipes, createMealSitting, deleteMealSitting } from "../dist/api/endpoints/meals.js";
import { getRewards, createReward, deleteReward } from "../dist/api/endpoints/rewards.js";
import { getNudges, createNudge, deleteNudge } from "../dist/api/endpoints/messages.js";

const frameArg = process.argv.find((a) => a.startsWith("--frame="));
const frameId = frameArg?.slice("--frame=".length) ?? "";
if (!/^\d{1,12}$/.test(frameId)) {
  console.error("Give the TEST frame's id: node scripts/plus-enforcement-check.mjs --frame=<digits>");
  process.exit(2);
}
const timezone = "America/Los_Angeles";
setQuietRequestLog(true);
const io = { input: process.stdin, output: process.stdout };

let pendingValue = null;
const pending = { save: async (v) => { pendingValue = v; }, take: async () => { const v = pendingValue; pendingValue = null; return v; } };
let stored = null;
const credential = { name: "memory (this process only)", read: async () => stored, write: async (c) => { stored = c; }, delete: async () => { const had = stored !== null; stored = null; return had; } };

console.log("Sign in to the TEST account (check the browser is not signed in to the family account).");
const started = await beginLogin({ pending });
await promptHidden("Press Enter to open the Skylight sign-in page... ", io);
const opened = await openSkylightUrl(started.loginUrl).catch(() => false);
console.log(opened ? "Opened your browser." : "Could not open a browser.");
console.log(`If it did not open, use this address:\n  ${started.loginUrl}`);
console.log("Then copy the https://ourskylight.com/welcome?code=... address from browser history (Cmd-Y).");
const redirectUrl = await promptHidden("Paste it here (it is not shown): ", io);
try {
  await completeLogin({ pending, credential, redirectUrl });
} catch (e) {
  console.log(`Sign-in failed: ${e?.code ?? e?.name ?? "error"}`);
  process.exit(1);
}

const config = { frameId, timezone, authType: "bearer" };
const client = new SkylightClient(config, credential, { quiet: true });
const run = (fn) => runWithContext({ client, config }, fn);

const PLUS = /plus|subscri/i;
const rows = [];
function verdictOf(error) {
  const status = error?.statusCode ?? null;
  const message = String(error?.message ?? "");
  if (status && PLUS.test(message)) {
    const said = message.match(/"errors":\["([^"]{0,160})/)?.[1] ?? message.slice(0, 160);
    return { status, verdict: "PLUS REFUSED", said };
  }
  return { status, verdict: status ? `refused (${status})` : `error (${error?.name ?? "unknown"})`, said: "" };
}
async function check(label, fn) {
  try {
    const value = await run(fn);
    rows.push({ label, status: 200, verdict: "allowed" });
    return value;
  } catch (e) {
    const v = verdictOf(e);
    rows.push({ label, ...v });
    return undefined;
  }
}

const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
const later = new Date(Date.now() + 30 * 86_400_000).toLocaleDateString("en-CA", { timeZone: timezone });

// Free features, as a control: these should all be allowed.
await check("read  calendar events (free)", () => getCalendarEvents({ dateMin: today, dateMax: today, timezone }));
await check("read  lists (free)", () => getLists());
await check("read  chores (free)", () => getChores({ after: today, before: today }));
const profiles = (await check("read  profiles (free)", () => getCategories())) ?? [];

// Free "Dinner plan": the exact body create_calendar_event sends with dinner: true.
const dinner = await check("write dinner plan, kind meal (free)", () => createCalendarEvent(dinnerPlanEvent({ title: "[plus-test] delete me", date: later, description: "", timeZone: timezone })));
if (dinner) {
  const back = await check("  read back that dinner plan", () => getCalendarEvents({ dateMin: later, dateMax: later, timezone }));
  const found = (Array.isArray(back) ? back : []).find((e) => String(e.id) === String(dinner.id));
  rows.push({ label: "  it reads back as kind meal, all day", status: null, verdict: found ? (found.attributes?.kind === "meal" && found.attributes?.all_day === true ? "yes" : "NO (shape differs)") : "NOT FOUND" });
  await check("  cleanup: delete that dinner plan", () => deleteCalendarEvent(String(dinner.id)));
}

// Plus features: reads.
const mealCats = (await check("read  meal categories (Plus)", () => getMealCategories())) ?? [];
await check("read  meal sittings (Plus)", () => getMealSittings({ dateMin: today, dateMax: later }));
await check("read  recipes (Plus)", () => getRecipes());
await check("read  rewards (Plus)", () => getRewards());
await check("read  messages (Plus)", () => getNudges(today, later, timezone));

// Plus features: writes, each deleted straight after if it went through.
if (mealCats[0]?.id) {
  const meal = await check("write meal (Plus)", () => createMealSitting({ date: later, mealCategoryId: String(mealCats[0].id), summary: "[plus-test] delete me" }));
  if (meal) await check("  cleanup: delete that meal", () => deleteMealSitting(meal, later));
} else {
  rows.push({ label: "write meal (Plus)", status: null, verdict: "skipped (no meal category readable)" });
}
const profile = profiles.find((p) => p?.attributes?.linked_to_profile) ?? profiles[0];
if (profile?.id) {
  const rewards = await check("write reward (Plus)", () => createReward({ name: "[plus-test] delete me", pointValue: 1, categoryIds: [String(profile.id)] }));
  for (const r of rewards ?? []) await check("  cleanup: delete that reward", () => deleteReward(String(r.id)));
} else {
  rows.push({ label: "write reward (Plus)", status: null, verdict: "skipped (no profile on the account)" });
}
const nudge = await check("write message (Plus)", () => createNudge({ body: "[plus-test] delete me", readAloud: false, timeZone: timezone }));
if (nudge) await check("  cleanup: delete that message", () => deleteNudge(nudge));

console.log("");
for (const r of rows) console.log(`${r.label.padEnd(34)} ${String(r.status ?? "-").padEnd(5)} ${r.verdict}${r.said ? `  ("${r.said}")` : ""}`);
const cleanupFailed = rows.some((r) => r.label.includes("cleanup") && r.verdict !== "allowed");
if (cleanupFailed) console.log("\nA cleanup failed: delete any [plus-test] record in the test account by hand.");
console.log("\nDone. The sign-in existed in memory only and is gone now.");
process.exit(0);
