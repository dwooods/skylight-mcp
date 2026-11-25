// Live check of `skylightDefault` and `labels` (1.29.0) against your own frame. Run from the clone after `npm run build`:
//   node scripts/library-default-labels-check.mjs
// READ ONLY: calls calendar.sources() and calendar.previewCreate() (a preview writes nothing). Uses the stored
// sign-in (macOS Keychain) and the settings file written by `init`.
// Prints only booleans, counts and pass/fail. It never prints a label, an id or an address, so the output is safe to paste.
import { createSkylight } from "../dist/lib.js";
import { defaultCredentialStore } from "../dist/api/credential-store.js";
import { readConfigFile } from "../dist/config-file.js";

const EMAIL = /[^\s@"']+@[^\s@"']+\.[a-z]{2,}/i;
const cfg = await readConfigFile();
if (!cfg) { console.error("No settings file. Run `skylight-mcp init` first."); process.exit(2); }
const base = { frameId: cfg.frameId, timezone: cfg.timezone, credential: defaultCredentialStore() };
const masked = createSkylight(base);
const asIs = createSkylight({ ...base, labels: "as-is" });

let failures = 0;
const check = (ok, text) => { if (!ok) failures++; console.log(`${ok ? "ok  " : "FAIL"} ${text}`); };
const info = (text) => console.log(`info ${text}`);

const day = new Date(Date.now() + 400 * 86_400_000).toLocaleDateString("en-CA", { timeZone: cfg.timezone });
const preview = (sky, calendar) => sky.calendar.previewCreate({ title: "preview only", start: `${day}T09:00`, end: `${day}T09:30`, calendar });

const [m, a] = [await masked.calendar.sources(), await asIs.calendar.sources()];
check(m.length === a.length && m.every((s, i) => s.id === a[i].id), `same sources in the same order under both settings (${m.length})`);

// 1. skylightDefault
const defaults = a.filter((s) => s.skylightDefault);
check(defaults.length <= 1, `at most one source has skylightDefault (found ${defaults.length})`);
check(defaults.length === 1, `exactly one source has skylightDefault (none would mean the household default is "No calendar")`);
if (defaults[0]) {
  info(`the default: kind ${defaults[0].kind}; writable ${defaults[0].writable}; role ${defaults[0].role ?? "none"}; label is email-shaped ${EMAIL.test(defaults[0].label)}`);
  check(defaults[0].kind === "google" && defaults[0].writable, "the default is a writable Google calendar");
}
check(m.every((s, i) => s.skylightDefault === a[i].skylightDefault), "skylightDefault is identical under masked and as-is");
const feedDefault = a.filter((s) => s.skylightDefault && s.kind !== "google").length;
check(feedDefault === 0, "no feed or other source is the default");

// 2. masked: nothing email-shaped may leave
const leaked = m.filter((s) => EMAIL.test(s.label)).length;
check(leaked === 0, `masked: no label is email-shaped (${leaked} leaked)`);
const placeholders = m.filter((s) => s.label === "Google calendar" || s.label === "Calendar").length;
info(`masked: ${placeholders} of ${m.length} labels are a placeholder`);

// 3. as-is: an email-shaped label comes back unchanged, and only where masked replaced it
const emailAsIs = a.filter((s) => EMAIL.test(s.label));
info(`as-is: ${emailAsIs.length} label(s) are email-shaped`);
check(a.every((s, i) => EMAIL.test(s.label) ? m[i].label !== s.label : m[i].label === s.label), "as-is differs from masked exactly on the email-shaped labels");
check(a.every((s) => s.label !== ""), "as-is: no empty label");
check(a.every((s, i) => s.kind === m[i].kind && s.writable === m[i].writable && s.role === m[i].role && s.host === m[i].host), "kind, writable, role and host are the same under both settings");
check(a.every((s) => s.host === null || !/[/?@]/.test(s.host.replace(/^[a-z]+:\/\//i, ""))), "feed host is scheme and host only");

// 4. the preview names the calendar exactly as sources() does (writable Google calendars only; nothing is written)
for (const [name, sky, list] of [["masked", masked, m], ["as-is", asIs, a]]) {
  let same = 0, tried = 0;
  for (const s of list.filter((x) => x.writable)) {
    tried++;
    try { const p = await preview(sky, s.id); if (p.calendar.label === s.label && p.calendar.kind === "google") same++; } catch { /* counted as not the same */ }
  }
  check(tried > 0 && same === tried, `${name}: previewCreate calendar.label equals sources() label for ${same} of ${tried} writable calendar(s)`);
}
try {
  const p = await preview(asIs, "skylight");
  check(p.calendar.kind === "skylight", 'previewCreate with calendar "skylight" names Skylight\'s own calendar');
} catch { check(false, 'previewCreate with calendar "skylight" failed'); }

console.log(failures === 0 ? "\nPASS" : `\nFAIL: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
