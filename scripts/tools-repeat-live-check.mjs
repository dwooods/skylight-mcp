// Live check of the MCP TOOLS' own output for meal repeats (1.28.0), through this clone's local server over stdio,
// against your own frame, with the same Keychain sign-in the local server uses. Run after `npm run build`:
//   node scripts/tools-repeat-live-check.mjs
// WRITES to the frame, then undoes itself: one throwaway series "ZZ tool repeat check" (Dinner, unassigned, every 2 weeks
// on Mon+Wed from 2027-03-01 until 2027-04-28) is created with create_meal_sitting, read with get_meal_sittings, its end
// moved to Mar 31 with update_meal_sitting (scope all: preview, then confirm), a scope "one" repeat change is checked to
// be refused, and it is deleted with delete_meal_sitting (scope all: preview, then confirm). A failure runs a cleanup delete.
// Prints step results only: no ids, no stored text.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TITLE = "ZZ tool repeat check";
const ALL = ["2027-03-01", "2027-03-03", "2027-03-15", "2027-03-17", "2027-03-29", "2027-03-31", "2027-04-12", "2027-04-14", "2027-04-26", "2027-04-28"];
const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06" };

const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("SKYLIGHT_")) delete env[k]; // use the saved sign-in, not stale variables
const client = new Client({ name: "tools-repeat-live-check", version: "1" });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "ignore" }));
} catch {
  console.error("The local server did not start. Run `node dist/index.js doctor` in this clone to see why.");
  process.exit(2);
}

let failed = 0;
const step = (name, ok, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ": " + extra : ""}`); if (!ok) failed++; return ok; };
const must = (name, ok, extra) => { if (!step(name, ok, extra)) throw new Error("stop"); };
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: (r.content ?? []).map((c) => c.text ?? "").join("\n"), isError: r.isError === true };
};
/** The dates (YYYY-MM-DD) get_meal_sittings lists for our title in Mar-Jun 2027, and the repeat tags on those lines. */
const ours = async () => {
  const { text } = await call("get_meal_sittings", { date: "2027-03-01", dateEnd: "2027-06-30" });
  const lines = text.split("\n").filter((l) => l.includes(TITLE));
  const dates = lines.map((l) => { const m = /(Jan|Feb|Mar|Apr|May|Jun) (\d{1,2})\b/.exec(l); return m ? `2027-${MON[m[1]]}-${m[2].padStart(2, "0")}` : "?"; }).sort();
  const tags = [...new Set(lines.map((l) => /\[repeats ([^\]]*)\]/.exec(l)?.[1] ?? "(none)"))];
  const id = lines.map((l) => /sitting ID: (\d+)/.exec(l)?.[1]).find(Boolean) ?? null;
  return { dates, tags, id };
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let id = null;
try {
  const { tools } = await client.listTools();
  const create = tools.find((t) => t.name === "create_meal_sitting");
  must("the local server's create_meal_sitting takes the object form of repeat (1.28.0)", JSON.stringify(create?.inputSchema ?? {}).includes("monthlyOn"));

  const cats = await call("get_meal_categories", {});
  const dinner = /Dinner \(ID: (\d+)\)/.exec(cats.text)?.[1];
  must("Dinner category found", !!dinner);
  must(`nothing titled "${TITLE}" in Mar-Jun 2027`, (await ours()).dates.length === 0);

  const c = await call("create_meal_sitting", { date: "2027-03-01", mealCategoryId: dinner, summary: TITLE, repeat: { every: "week", interval: 2, weekdays: ["MO", "WE"], until: "2027-04-28" } });
  id = /sitting ID: (\d+)/.exec(c.text)?.[1] ?? null;
  must("create succeeded and named an id", !c.isError && !!id);
  step("create's reply describes the rule and the first and last dates", c.text.includes("repeating every 2 weeks on Mon, Wed until 2027-04-28 (first: 2027-03-01, 2027-03-03, 2027-03-15, 2027-03-17, 2027-03-29; last: 2027-04-28)"));
  step("create's reply has no warning about a different stored rule", !c.text.includes("WARNING"));

  let r = await ours();
  step("get_meal_sittings lists exactly the expected ten days", same(r.dates, ALL), r.dates.join(" "));
  step("each line says how it repeats", same(r.tags, ["every 2 weeks on Mon, Wed until 2027-04-28"]), r.tags.join(" | "));

  const args = { sittingId: id, date: "2027-03-15", scope: "all", repeat: { every: "week", interval: 2, weekdays: ["MO", "WE"], until: "2027-03-31" } };
  const p = await call("update_meal_sitting", args);
  step("update preview: not changed, names the new rule and its dates", !p.isError && p.text.includes("NOT CHANGED") && p.text.includes("repeat set to every 2 weeks on Mon, Wed until 2027-03-31") && p.text.includes("last 2027-03-31"));
  step("update preview wrote nothing", same((await ours()).dates, ALL));

  const u = await call("update_meal_sitting", { ...args, confirm: true });
  step("update applied, series still starts Mar 1, rule read back as stored", !u.isError && u.text.includes("still starts") && u.text.includes("Read back: Skylight stores the new rule"), u.isError ? "error" : "");
  r = await ours();
  step("now ends Mar 31: the six earlier days, nothing after", same(r.dates, ALL.slice(0, 6)), r.dates.join(" "));
  step("the lines show the new end", same(r.tags, ["every 2 weeks on Mon, Wed until 2027-03-31"]), r.tags.join(" | "));

  const one = await call("update_meal_sitting", { sittingId: id, date: "2027-03-15", scope: "one", repeat: { every: "week", until: "2027-03-31" }, confirm: true });
  step("a repeat change with scope one is refused", one.isError);
  step("the refusal wrote nothing", same((await ours()).dates, ALL.slice(0, 6)));

  const dp = await call("delete_meal_sitting", { sittingId: id, date: "2027-03-01", scope: "all" });
  step("delete preview: not deleted", !dp.isError && dp.text.includes("NOT DELETED") && (await ours()).dates.length === 6);
  const d = await call("delete_meal_sitting", { sittingId: id, date: "2027-03-01", scope: "all", confirm: true });
  step("delete applied", !d.isError);
  id = null;
  step("read back: gone", (await ours()).dates.length === 0);
} catch (e) {
  if (e?.message !== "stop") step("unexpected error", false, e?.name ?? "Error");
} finally {
  if (id) {
    try {
      await call("delete_meal_sitting", { sittingId: id, date: "2027-03-01", scope: "all", confirm: true });
      const left = (await ours()).dates.length;
      step("cleanup", left === 0, left ? `delete "${TITLE}" from 2027-03-01 in the app` : "nothing left");
    } catch { step("cleanup", false, `delete "${TITLE}" from 2027-03-01 in the app`); }
  }
  await client.close();
}
console.log(failed === 0 ? "\nPASS: the tools' own output for meal repeats matched on the real frame." : `\nFAIL: ${failed} step(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
