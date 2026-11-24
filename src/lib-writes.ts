/**
 * Event writes for the library entry (experimental). Stage 1: create a one-off event.
 *
 * Every write is two functions with identical arguments: a preview that changes nothing and a
 * commit. Both call the same plan function, so the checks cannot drift: the commit re-runs
 * every check against fresh reads (the calendar can change between the two calls), then writes,
 * then reads back.
 *
 * Errors for input and for the write itself are plain Errors with `name` "SkylightWriteError"
 * and a stable `code`. Their messages are the library's own wording: Skylight's response text is
 * never included (the HTTP client puts it in its own error messages, so every write error is
 * mapped here). Sign-in errors pass through unchanged (`AuthenticationError`).
 *
 * Nothing here returns a calendar address, an account id or an email: the Google calendar is
 * chosen by its `calendar.sources()` id and resolved inside the call.
 */

import { getClient } from "./api/client.js";
import { getCalendarEvents, createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from "./api/endpoints/calendar.js";
import { getCategories } from "./api/endpoints/categories.js";
import { isoWithOffset } from "./api/endpoints/messages.js";
import { readBackUntil } from "./api/endpoints/source-calendars.js";
import type { CalendarEventResource, CategoryResource, CreateCalendarEventRequest, SourceCalendarResource } from "./api/types.js";
import { addDays, dateInZone, toLocalParts, zonedToEpoch } from "./utils/schedule.js";
import { planSeries, SeriesError, type SeriesInput } from "./utils/series.js";

export type WriteErrorCode =
  | "bad_input"
  | "invalid_title"
  | "invalid_time"
  | "end_before_start"
  | "unknown_profile"
  | "unknown_label"
  | "label_not_assignable"
  | "unknown_calendar"
  | "unknown_meal_category"
  | "calendar_not_writable"
  | "unsupported"
  | "invalid_repeat"
  | "not_found"
  | "stale"
  | "not_editable"
  | "scope_required"
  | "scope_not_allowed"
  | "skylight_refused"
  | "outcome_unknown"
  | "not_confirmed"
  | "read_failed";

export interface SkylightWriteError extends Error {
  name: "SkylightWriteError";
  code: WriteErrorCode;
  /** HTTP status, for `skylight_refused` only. */
  status?: number;
  /** The id Skylight gave the record (event or meal), for `not_confirmed` only. */
  eventId?: string;
  /** The ids that were not accepted, for `unknown_profile`, `unknown_label` and `label_not_assignable`. */
  ids?: string[];
}

export function writeError(code: WriteErrorCode, message: string, extra: { status?: number; eventId?: string; ids?: string[] } = {}): SkylightWriteError {
  const e = new Error(message) as SkylightWriteError;
  e.name = "SkylightWriteError";
  e.code = code;
  if (extra.status !== undefined) e.status = extra.status;
  if (extra.eventId !== undefined) e.eventId = extra.eventId;
  if (extra.ids !== undefined) e.ids = extra.ids;
  return e;
}

/**
 * A new one-off event. Times are wall-clock in the frame's time zone: no offset, no "Z".
 * - Timed: `start` and `end` are "YYYY-MM-DDTHH:MM"; `end` after `start`.
 * - All day: `allDay: true`, `start` is "YYYY-MM-DD", and `end` is left out or the same date
 *   (one day; multi-day all-day events are not supported yet).
 * `calendar` is required: "skylight" for Skylight's own calendar (shows on Skylight only), or the
 * `id` of a Google calendar from `calendar.sources()` whose `writable` is true (Skylight writes it
 * through to Google, where everyone who shares that calendar sees it).
 */
export interface CreateEventInput {
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  notes?: string;
  /** Profile ids from `profiles.list()`. */
  profileIds?: string[];
  /** Label ids from `labels.list()`. A label a synced calendar writes to is refused. */
  labelIds?: string[];
  calendar: string;
  /**
   * Make it a repeating series. `every`: "day", "week", "month" or "year"; `interval` (default 1);
   * monthly `monthlyOn`: "date" (the start's day, default) or "weekday" (e.g. the 3rd Tuesday, from
   * the start); end with `until` (YYYY-MM-DD) or `count`. Daily and weekly need an end; monthly and
   * yearly may be open-ended. Weekly repeats on the start's weekday only.
   */
  repeat?: SeriesInput;
}

/** Exactly what a create would write, in library terms. Times are as they will be sent (ISO with the frame's offset, or dates for all day). */
export interface CreatePreview {
  action: "create";
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  notes: string | null;
  profileIds: string[];
  profiles: string[];
  labelIds: string[];
  labels: string[];
  calendar: { id: string; label: string; kind: "skylight" | "google" };
  timezone: string;
  /** For a series: the rule in words, its first dates, and months or years it skips. Null for a one-off. */
  repeat: { rule: string; first: string[]; skipped: string[]; last: string | null } | null;
  /** Things the person may not expect, e.g. months a monthly rule skips. Show them with the preview. */
  warnings: string[];
}

const CREATE_KEYS = new Set(["title", "start", "end", "allDay", "location", "notes", "profileIds", "labelIds", "calendar", "repeat"]);
const TITLE_MAX = 200;
const LOCATION_MAX = 500;
const NOTES_MAX = 5000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const ID = /^\d+$/;
// Control characters other than tab and newline (notes may have line breaks; a title may not).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/;

function realDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t).toISOString().slice(0, 10) === value;
}

/** Epoch ms for a wall-clock time, refusing a time the zone skips (a clock change). */
function localToEpoch(value: string, timeZone: string, field: "start" | "end"): number {
  const m = LOCAL_TIME.exec(value);
  if (!m || !realDate(m[1]!) || Number(m[2]) > 23 || Number(m[3]) > 59) {
    throw writeError("invalid_time", `${field} must be a local time YYYY-MM-DDTHH:MM, with no offset or Z.`);
  }
  const epoch = zonedToEpoch(m[1]!, `${m[2]}:${m[3]}`, timeZone);
  const p = toLocalParts(epoch, timeZone);
  if (dateInZone(epoch, timeZone) !== m[1] || p.hour !== Number(m[2]) || p.minute !== Number(m[3])) {
    throw writeError("invalid_time", `${field} does not exist in ${timeZone} (the clocks change at that time).`);
  }
  return epoch;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw writeError("bad_input", `${field} must be text.`);
  if (CONTROL.test(value)) throw writeError("bad_input", `${field} contains control characters.`);
  if (value.length > max) throw writeError("bad_input", `${field} is longer than ${max} characters.`);
  return value.trim() === "" ? null : value;
}

function idList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && ID.test(v))) {
    throw writeError("bad_input", `${field} must be a list of ids (digits), from the library's lists.`);
  }
  if (new Set(value).size !== value.length) throw writeError("bad_input", `${field} lists an id twice.`);
  return [...value] as string[];
}

/** Source calendars with their account link. The included account records hold an email and are never read here. */
async function sourcesWithAccounts(): Promise<SourceCalendarResource[]> {
  const response = await getClient().get<{ data: SourceCalendarResource[] }>("/api/frames/{frameId}/source_calendars", { include: "calendar_account" });
  return response.data ?? [];
}

/**
 * The name a source calendar leaves the library with, in sources() and in the create preview alike. A label
 * Skylight gives is returned as it is, except an email-shaped one, which is replaced by default so no address
 * escapes: "Google calendar" for a Google calendar, "Calendar" for any other kind. A missing or empty label gets
 * the same placeholder. Nothing is numbered: two calendars can share a placeholder, so tell them apart by `id`.
 * With `asIs` (the importer's opt-in, `labels: "as-is"`) a label is returned exactly as Skylight has it, an
 * email address included; only a missing or empty label is replaced. Only the label is ever returned: never the
 * calendar's source id or its account.
 */
export function sourceLabels(cals: SourceCalendarResource[], asIs = false): Map<string, string> {
  const labels = new Map<string, string>();
  for (const cal of cals) {
    const a = cal.attributes as Record<string, unknown>;
    const label = typeof a.label === "string" ? a.label : "";
    labels.set(String(cal.id), label !== "" && (asIs || !EMAIL.test(label)) ? label : a.kind === "gmail" ? "Google calendar" : "Calendar");
  }
  return labels;
}

/** True when the Skylight app preselects this calendar for new events (`default_for_new_events`). */
export function sourceIsDefault(cal: SourceCalendarResource): boolean {
  return (cal.attributes as Record<string, unknown>).default_for_new_events === true;
}

/** True when the library can create on this source: a Google calendar this account can write to. */
export function sourceWritable(cal: SourceCalendarResource): boolean {
  const a = cal.attributes as Record<string, unknown>;
  return a.kind === "gmail" && a.editable !== false && a.role !== "reader";
}

interface CreatePlan {
  preview: CreatePreview;
  body: CreateCalendarEventRequest;
  /** For the read-back. */
  startDate: string;
  endDate: string;
  startMs: number;
  endMs: number;
  categoryIds: string[];
  source: "skylight" | "google";
  /** FREQ of a series, for the read-back; null for a one-off. */
  freq: string | null;
}

/** The one check behind previewCreate and create. Reads categories and calendars fresh every time. */
/** The one check behind previewCreate and create. It only reads; a failed read is `read_failed`. */
export function planCreate(input: unknown, timeZone: string, labelsAsIs = false): Promise<CreatePlan> {
  return asRead(() => planCreateInner(input, timeZone, labelsAsIs));
}

async function planCreateInner(input: unknown, timeZone: string, labelsAsIs: boolean): Promise<CreatePlan> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw writeError("bad_input", "create needs an object of event fields.");
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!CREATE_KEYS.has(key)) throw writeError("bad_input", `Unknown field "${key}".`);
  }

  if (typeof raw.title !== "string" || raw.title.trim() === "") throw writeError("invalid_title", "title must be non-empty text.");
  const title = raw.title.trim();
  if (title.length > TITLE_MAX) throw writeError("invalid_title", `title is longer than ${TITLE_MAX} characters.`);
  if (/[\r\n]/.test(title) || CONTROL.test(title)) throw writeError("invalid_title", "title must be one line with no control characters.");

  if (raw.allDay !== undefined && typeof raw.allDay !== "boolean") throw writeError("bad_input", "allDay must be true or false.");
  const allDay = raw.allDay === true;
  if (typeof raw.start !== "string") throw writeError("invalid_time", "start is required.");
  if (raw.end !== undefined && typeof raw.end !== "string") throw writeError("invalid_time", "end must be text.");

  let startSent: string;
  let endSent: string;
  let startDate: string;
  let endDate: string;
  let startMs: number;
  let endMs: number;
  if (allDay) {
    if (!realDate(raw.start)) throw writeError("invalid_time", "For an all-day event start must be a date, YYYY-MM-DD.");
    if (raw.end !== undefined && !realDate(raw.end)) throw writeError("invalid_time", "For an all-day event end must be a date, YYYY-MM-DD, or left out.");
    if (raw.end !== undefined && raw.end < raw.start) throw writeError("end_before_start", "end is before start.");
    if (raw.end !== undefined && raw.end !== raw.start) {
      throw writeError("unsupported", "An all-day event covers one day: leave end out or give the same date. Multi-day all-day events are not supported yet.");
    }
    startDate = raw.start;
    endDate = raw.start;
    startSent = raw.start;
    endSent = addDays(raw.start, 1); // Skylight's all-day end is the next day (exclusive), as the app sends it
    startMs = zonedToEpoch(startDate, "00:00", timeZone);
    endMs = zonedToEpoch(endSent, "00:00", timeZone);
  } else {
    if (raw.end === undefined) throw writeError("invalid_time", "end is required for a timed event.");
    startMs = localToEpoch(raw.start, timeZone, "start");
    endMs = localToEpoch(raw.end, timeZone, "end");
    if (endMs <= startMs) throw writeError("end_before_start", "end must be after start.");
    startSent = isoWithOffset(startMs, timeZone);
    endSent = isoWithOffset(endMs, timeZone);
    startDate = dateInZone(startMs, timeZone);
    endDate = dateInZone(endMs - 1, timeZone);
  }

  const location = optionalText(raw.location, "location", LOCATION_MAX);
  const notes = optionalText(raw.notes, "notes", NOTES_MAX);
  const profileIds = idList(raw.profileIds, "profileIds");
  const labelIds = idList(raw.labelIds, "labelIds");
  let series: ReturnType<typeof planSeries> | null = null;
  if (raw.repeat !== undefined) {
    const startTime = allDay ? "00:00" : `${String(toLocalParts(startMs, timeZone).hour).padStart(2, "0")}:${String(toLocalParts(startMs, timeZone).minute).padStart(2, "0")}`;
    try {
      series = planSeries(raw.repeat, startDate, startTime, timeZone);
    } catch (error) {
      if (error instanceof SeriesError) throw writeError("invalid_repeat", error.message);
      throw error;
    }
  }
  if (typeof raw.calendar !== "string" || (raw.calendar !== "skylight" && !ID.test(raw.calendar))) {
    throw writeError("bad_input", 'calendar is required: "skylight", or the id of a Google calendar from calendar.sources().');
  }

  // Fresh reads: a profile, label or calendar removed a minute ago must not be written to.
  const categories = await getCategories(false);
  const byId = new Map(categories.map((c) => [String(c.id), c]));
  const name = (c: CategoryResource): string => {
    const label = typeof c.attributes.label === "string" ? c.attributes.label : "";
    return EMAIL.test(label) ? "Calendar" : label;
  };
  const badProfiles = profileIds.filter((id) => byId.get(id)?.attributes.linked_to_profile !== true);
  if (badProfiles.length) throw writeError("unknown_profile", "Not a profile on this frame: see profiles.list().", { ids: badProfiles });
  const unknownLabels = labelIds.filter((id) => {
    const c = byId.get(id);
    return !c || c.attributes.linked_to_profile === true;
  });
  if (unknownLabels.length) throw writeError("unknown_label", "Not a label on this frame: see labels.list().", { ids: unknownLabels });
  const fedLabels = labelIds.filter((id) => (byId.get(id)?.relationships?.source_calendars?.data ?? []).length > 0);
  if (fedLabels.length) {
    throw writeError("label_not_assignable", "A synced calendar writes to this label; Skylight assigns it to that calendar's events itself.", { ids: fedLabels });
  }

  let target: { calendarId: string; accountId: string | number; label: string; id: string } | null = null;
  if (raw.calendar !== "skylight") {
    const all = await sourcesWithAccounts();
    const cal = all.find((c) => String(c.id) === raw.calendar);
    if (!cal) throw writeError("unknown_calendar", "No synced calendar with that id: see calendar.sources().");
    const a = cal.attributes as Record<string, unknown>;
    if (!sourceWritable(cal)) throw writeError("calendar_not_writable", "That calendar is not a Google calendar this account can write to.");
    const sourceId = typeof a.source_id === "string" ? a.source_id : "";
    const account = (cal.relationships as { calendar_account?: { data?: { id?: unknown } | null } } | undefined)?.calendar_account?.data?.id;
    if (!sourceId || !((typeof account === "string" && account !== "") || typeof account === "number")) {
      throw writeError("calendar_not_writable", "Skylight did not report that calendar's account, so it cannot be written to.");
    }
    const label = sourceLabels(all, labelsAsIs).get(String(cal.id))!;
    target ={ calendarId: sourceId, accountId: account, label, id: String(cal.id) };
  }

  const categoryIds = [...profileIds, ...labelIds];
  const body: CreateCalendarEventRequest = {
    summary: title,
    kind: "standard",
    starts_at: startSent,
    ends_at: endSent,
    all_day: allDay,
    timezone: timeZone,
    description: notes ?? "",
    location: location ?? "",
    category_ids: categoryIds,
    ...(series ? { rrule: [series.rrule] } : {}),
    ...(target ? { calendar_id: target.calendarId, calendar_account_id: target.accountId } : {}),
  };
  const preview: CreatePreview = {
    action: "create",
    title,
    start: startSent,
    end: endSent,
    allDay,
    location,
    notes,
    profileIds,
    profiles: profileIds.map((id) => name(byId.get(id)!)),
    labelIds,
    labels: labelIds.map((id) => name(byId.get(id)!)),
    calendar: target ? { id: target.id, label: target.label, kind: "google" } : { id: "skylight", label: "Skylight", kind: "skylight" },
    timezone: timeZone,
    repeat: series ? { rule: series.rule, first: series.first, skipped: series.skipped, last: series.last } : null,
    warnings: series ? [...series.warnings] : [],
  };
  const freq = series ? /FREQ=([A-Z]+)/.exec(series.rrule)![1]! : null;
  return { preview, body, startDate, endDate, startMs, endMs, categoryIds, source: target ? "google" : "skylight", freq };
}

function isPassThrough(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "SkylightWriteError" || name === "AuthenticationError" || name === "CredentialSaveError";
}

/**
 * A read that fails before anything is written (a plan, a pre-write snapshot). The library's own
 * errors and sign-in errors pass through; anything else (a network error, a Skylight server error,
 * whose message carries Skylight's response text) becomes `read_failed`: nothing was written.
 */
export function mapReadFailure(error: unknown): unknown {
  if (isPassThrough(error)) return error;
  return writeError("read_failed", "Skylight did not answer a read, so nothing was written. It is safe to try again.");
}

/** Run something that only reads (a plan or a preview) with its failures mapped by mapReadFailure. */
export async function asRead<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapReadFailure(error);
  }
}

/**
 * A read made after the write was accepted. If it fails, the write stands: report `not_confirmed`
 * with the id (never Skylight's text), so the importer reads before trying again.
 */
export async function afterWrite<T>(id: string, what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "SkylightWriteError") throw error;
    throw writeError("not_confirmed", `Skylight accepted the write, but reading it back failed. Read ${what} before trying again.`, { eventId: id });
  }
}

/**
 * After a write ended in `outcome_unknown`, read back (with the usual retries) to see whether it
 * landed. `check` resolves with the stored result when it did, undefined when it did not show.
 * Landed: resolve as a normal success. Not seen, or the check itself failed: `outcome_unknown`.
 */
export async function settleUnknown<T>(failure: unknown, what: string, check: () => Promise<T | undefined>): Promise<T> {
  if ((failure as { code?: string } | null)?.code !== "outcome_unknown") throw failure;
  let landed: T | undefined;
  try {
    landed = await check();
  } catch {
    throw failure;
  }
  if (landed !== undefined) return landed;
  throw writeError(
    "outcome_unknown",
    `The write was sent but no answer came back (a network error or a Skylight server error), and reading back about two seconds later did not show it. It is probably not written, but Skylight's list can lag: read ${what} before trying again.`
  );
}

/** Map anything the write itself threw to the library's own error, never Skylight's text. Sign-in errors pass through. */
export function mapWriteFailure(error: unknown, what = "the calendar"): unknown {
  const e = error as { name?: string; statusCode?: number } | null;
  if (e && (e.name === "AuthenticationError" || e.name === "CredentialSaveError")) return error;
  const status = typeof e?.statusCode === "number" ? e.statusCode : undefined;
  if (status !== undefined && status >= 400 && status < 500) {
    return writeError("skylight_refused", `Skylight refused the write (HTTP ${status}). Nothing was written.`, { status });
  }
  return writeError("outcome_unknown", `The write was sent but no answer came back (a network error or a Skylight server error). It may or may not have been written: read ${what} before trying again.`);
}

function sameText(stored: unknown, wanted: string | null): boolean {
  const s = typeof stored === "string" ? stored : "";
  return s.trim() === (wanted ?? "").trim();
}

/** Did Skylight store what was asked? Profiles and labels asked for must all be there; Skylight may add the calendar's own label. */
function matchesPlan(event: CalendarEventResource, plan: CreatePlan, categoryIdsOf: (e: CalendarEventResource) => string[]): boolean {
  const a = event.attributes as Record<string, unknown>;
  if (a.summary !== plan.preview.title) return false;
  if ((a.all_day === true) !== plan.preview.allDay) return false;
  if (Date.parse(String(a.starts_at)) !== plan.startMs || Date.parse(String(a.ends_at)) !== plan.endMs) {
    // All-day records come back as local midnights with an offset; timed ones as instants. Both are compared as instants.
    return false;
  }
  if (!sameText(a.location, plan.preview.location) || !sameText(a.description, plan.preview.notes)) return false;
  if (a.source !== plan.source) return false;
  if (plan.freq !== null) {
    const rule = Array.isArray(a.rrule) ? a.rrule.join(";") : "";
    if (a.recurring !== true || !rule.includes(`FREQ=${plan.freq}`)) return false;
  } else if (a.recurring === true) return false;
  const stored = new Set(categoryIdsOf(event));
  return plan.categoryIds.every((id) => stored.has(id));
}

/**
 * Create, then read back. Returns the stored record only when the read-back shows every field as
 * asked; otherwise throws `not_confirmed` with the id Skylight gave (the event may still appear:
 * Skylight's list can lag a write).
 */
export async function commitCreate(
  input: unknown,
  timeZone: string,
  categoryIdsOf: (e: CalendarEventResource) => string[],
  labelsAsIs = false
): Promise<CalendarEventResource> {
  const plan = await planCreate(input, timeZone, labelsAsIs);
  const read = () => getCalendarEvents({ dateMin: plan.startDate, dateMax: plan.endDate, timezone: timeZone });
  const base = (e: CalendarEventResource) => String(e.id).split("-")[0]!;
  // What was already there, so a self-check after an unknown outcome can tell a new event from an old one.
  const before = new Set((await asRead(read)).map(base));
  let created: CalendarEventResource;
  try {
    created = await createCalendarEvent(plan.body);
  } catch (error) {
    return settleUnknown(mapWriteFailure(error), "the calendar", async () => {
      const fresh = (list: CalendarEventResource[]) => list.filter((e) => !before.has(base(e)) && matchesPlan(e, plan, categoryIdsOf));
      const back = await readBackUntil(read, (list) => fresh(list).length > 0);
      const found = fresh(back.value);
      // Exactly one new event (one series) that fits: that is the write. Two would be a guess.
      if (new Set(found.map(base)).size !== 1) return undefined;
      return [...found].sort((a, b) => String(a.attributes.starts_at).localeCompare(String(b.attributes.starts_at)))[0];
    });
  }
  const id = created?.id !== undefined && created?.id !== null ? String(created.id) : "";
  if (!id) throw writeError("outcome_unknown", "Skylight accepted the write but did not say which event it created. Read the calendar before trying again.");
  const back = await afterWrite(id, "the calendar", () =>
    readBackUntil(read, (list) => list.some((e) => String(e.id) === id && matchesPlan(e, plan, categoryIdsOf)))
  );
  const stored = back.value.find((e) => String(e.id) === id);
  if (!back.ok || !stored) {
    throw writeError(
      "not_confirmed",
      stored
        ? "Skylight created the event but reading it back shows different fields from those asked. Read it before changing it."
        : "Skylight accepted the write but the event did not show on reading it back. It may still appear: read the calendar before trying again.",
      { eventId: id }
    );
  }
  return stored;
}

// ---------------------------------------------------------------------------------------------
// Stage 2: update and delete. An event is named by what a read returned: its id, the date it was
// read on, and its version (a fingerprint of the fields shown). The commit reads the event again
// and refuses if the version moved, so an edit made from an old screen is refused, not applied.
// Skylight has no conditional write, so a change landing between that re-read and the write is
// not caught.
// ---------------------------------------------------------------------------------------------

/** FNV-1a, twice with different seeds: a stable 16-hex fingerprint with no crypto (runs in Workers). */
export function fnv(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The version of an event as read: changes when its title, times, all-day, location, notes, people, labels or rule change. */
export function eventVersion(event: CalendarEventResource, categoryIdsOf: (e: CalendarEventResource) => string[]): string {
  const a = event.attributes as Record<string, unknown>;
  const text = JSON.stringify([
    String(event.id),
    typeof a.summary === "string" ? a.summary : "",
    Date.parse(String(a.starts_at)),
    Date.parse(String(a.ends_at)),
    a.all_day === true,
    typeof a.location === "string" ? a.location.trim() : "",
    typeof a.description === "string" ? a.description.trim() : "",
    [...categoryIdsOf(event)].sort(),
    Array.isArray(a.rrule) ? a.rrule.join("|") : "",
    a.master_event_id == null ? "" : String(a.master_event_id),
  ]);
  return fnv(text, 0x811c9dc5) + fnv(text, 0x9747b28c);
}

/** What a read returned for one event: the id, the date it was read on, and its version. */
export interface EventRef {
  id: string;
  date: string;
  version: string;
}

export interface UpdateEventInput extends EventRef {
  /** Repeating events only: "one" (this occurrence; it becomes its own event) or "all" (the whole series). */
  scope?: "one" | "all";
  /**
   * What to change; anything left out stays. One-off events (and occurrences already edited on their
   * own): any field. A series: title, profileIds, labelIds, and start with end on the same date (time
   * of day only). Times as for create.
   */
  changes: {
    title?: string;
    start?: string;
    end?: string;
    allDay?: boolean;
    location?: string;
    notes?: string;
    profileIds?: string[];
    labelIds?: string[];
  };
}

export interface DeleteEventInput extends EventRef {
  /** Repeating events only: "one", "future" (this and every later one) or "all" (the whole series). */
  scope?: "one" | "future" | "all";
}

/** The event as read before the change, in library terms. Produced by the caller's projection. */
export type EventProjection<T> = (event: CalendarEventResource) => Promise<T>;

export interface UpdatePreview<T> {
  action: "update";
  /** The event as it is now. */
  event: T;
  scope: "one" | "all" | null;
  /** The fields that will be written, in library terms (times as they will be sent). */
  changes: { title?: string; start?: string; end?: string; allDay?: boolean; location?: string | null; notes?: string | null; profileIds?: string[]; labelIds?: string[] };
  /** What the change reaches, in words. */
  effect: string;
  /** True when the event is on a Google calendar: the change reaches Google for everyone who shares it. */
  google: boolean;
  warnings: string[];
}

export interface DeletePreview<T> {
  action: "delete";
  event: T;
  scope: "one" | "future" | "all" | null;
  effect: string;
  google: boolean;
}

const REF_KEYS = ["id", "date", "version"];
const UPDATE_KEYS = new Set([...REF_KEYS, "scope", "changes"]);
const DELETE_KEYS = new Set([...REF_KEYS, "scope"]);
const CHANGE_KEYS = new Set(["title", "start", "end", "allDay", "location", "notes", "profileIds", "labelIds"]);
const EVENT_ID = /^\d+(-\d+)?$/;

interface Found {
  event: CalendarEventResource;
  kind: "one-off" | "series" | "detached";
  google: boolean;
}

/** Read the event fresh and check it is the one the caller saw and that Skylight can change it. */
async function findForWrite(
  raw: Record<string, unknown>,
  keys: Set<string>,
  timeZone: string,
  categoryIdsOf: (e: CalendarEventResource) => string[],
  verb: string
): Promise<Found> {
  for (const key of Object.keys(raw)) if (!keys.has(key)) throw writeError("bad_input", `Unknown field "${key}".`);
  if (typeof raw.id !== "string" || !EVENT_ID.test(raw.id)) throw writeError("bad_input", "id must be an event id from calendar.events().");
  if (typeof raw.date !== "string" || !realDate(raw.date)) throw writeError("bad_input", "date must be the event's date, YYYY-MM-DD, as read.");
  if (typeof raw.version !== "string" || raw.version === "") throw writeError("bad_input", "version is required: pass the event's version from calendar.events().");
  const list = await getCalendarEvents({ dateMin: raw.date, dateMax: raw.date, timezone: timeZone });
  const event = list.find((e) => String(e.id) === raw.id);
  if (!event) throw writeError("not_found", `No event with that id on ${raw.date}: it may have moved or been deleted. Read the calendar again.`);
  if (eventVersion(event, categoryIdsOf) !== raw.version) {
    throw writeError("stale", `The event changed since it was read. Nothing was ${verb}: read it again and show the new version before asking again.`);
  }
  const a = event.attributes as Record<string, unknown>;
  if (a.source !== "skylight" && a.source !== "google") throw writeError("not_editable", "That event comes from a subscribed calendar, which is read-only.");
  if (a.editable === false) throw writeError("not_editable", "Skylight marks that event as not editable.");
  const detached = a.master_event_id != null && a.master_event_id !== "";
  const series = !detached && (a.recurring === true || a.recurring_config === true);
  return { event, kind: detached ? "detached" : series ? "series" : "one-off", google: a.source === "google" };
}

function seriesKeyOf(event: CalendarEventResource): { uid: string; number: string } {
  const a = event.attributes as Record<string, unknown>;
  return { uid: typeof a.uid === "string" ? a.uid : "", number: String(event.id).split("-")[0]! };
}

interface UpdatePlan {
  found: Found;
  scope: "one" | "all" | null;
  body: Record<string, unknown>;
  changes: UpdatePreview<unknown>["changes"];
  effect: string;
  /** What the read-back must see. */
  expect: { title?: string; startMs?: number; endMs?: number; allDay?: boolean; location?: string | null; notes?: string | null; categoryIds: string[]; readDates: string[] };
}

/** The one check behind previewUpdate and update. */
export function planUpdate(input: unknown, timeZone: string, categoryIdsOf: (e: CalendarEventResource) => string[]): Promise<UpdatePlan> {
  return asRead(() => planUpdateInner(input, timeZone, categoryIdsOf));
}

async function planUpdateInner(input: unknown, timeZone: string, categoryIdsOf: (e: CalendarEventResource) => string[]): Promise<UpdatePlan> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw writeError("bad_input", "update needs an object: id, date, version, changes.");
  const raw = input as Record<string, unknown>;
  const changesRaw = raw.changes;
  if (!changesRaw || typeof changesRaw !== "object" || Array.isArray(changesRaw)) throw writeError("bad_input", "changes must be an object of the fields to change.");
  const c = changesRaw as Record<string, unknown>;
  for (const key of Object.keys(c)) if (!CHANGE_KEYS.has(key)) throw writeError("bad_input", `Unknown change "${key}".`);
  if (Object.keys(c).length === 0) throw writeError("bad_input", "Nothing to change.");
  if (raw.scope !== undefined && raw.scope !== "one" && raw.scope !== "all") {
    throw writeError("scope_not_allowed", raw.scope === "future" ? 'Skylight refuses "this and following" for an edit: use "one" or "all".' : 'scope must be "one" or "all".');
  }

  const found = await findForWrite(raw, UPDATE_KEYS, timeZone, categoryIdsOf, "changed");
  const a = found.event.attributes as Record<string, unknown>;
  const scope = (raw.scope as "one" | "all" | undefined) ?? null;
  if (found.kind === "series" && scope === null) throw writeError("scope_required", 'That is an occurrence of a repeating event: say scope "one" (only this one) or "all" (the whole series).');
  if (found.kind !== "series" && scope !== null) throw writeError("scope_not_allowed", "scope applies to an occurrence of a repeating event only.");
  if (found.kind === "series") {
    const bad = ["allDay", "location", "notes"].filter((k) => c[k] !== undefined);
    if (bad.length) throw writeError("unsupported", `On a repeating event only the title, people, labels and time of day can be changed here (${bad.join(", ")} on a series is not verified).`);
    if ((c.start === undefined) !== (c.end === undefined)) throw writeError("invalid_time", "To change a repeating event's time give both start and end.");
  }

  const changes: UpdatePlan["changes"] = {};
  const body: Record<string, unknown> = {};
  const expect: UpdatePlan["expect"] = { categoryIds: [], readDates: [raw.date as string] };

  if (c.title !== undefined) {
    if (typeof c.title !== "string" || c.title.trim() === "") throw writeError("invalid_title", "title must be non-empty text.");
    const title = c.title.trim();
    if (title.length > TITLE_MAX) throw writeError("invalid_title", `title is longer than ${TITLE_MAX} characters.`);
    if (/[\r\n]/.test(title) || CONTROL.test(title)) throw writeError("invalid_title", "title must be one line with no control characters.");
    changes.title = title;
    body.summary = title;
    expect.title = title;
  }

  const wasAllDay = a.all_day === true;
  if (c.allDay !== undefined && typeof c.allDay !== "boolean") throw writeError("bad_input", "allDay must be true or false.");
  const allDay = c.allDay === undefined ? wasAllDay : c.allDay;
  if (c.allDay !== undefined && c.allDay !== wasAllDay && (c.start === undefined)) {
    throw writeError("invalid_time", "Changing all-day needs a new start (and end for a timed event).");
  }
  if (c.start !== undefined || c.end !== undefined) {
    if (c.start !== undefined && typeof c.start !== "string") throw writeError("invalid_time", "start must be text.");
    if (c.end !== undefined && typeof c.end !== "string") throw writeError("invalid_time", "end must be text.");
    let startMs: number;
    let endMs: number;
    if (allDay) {
      const day = (c.start as string | undefined) ?? dateInZone(Date.parse(String(a.starts_at)), timeZone);
      if (!realDate(day)) throw writeError("invalid_time", "For an all-day event start must be a date, YYYY-MM-DD.");
      if (c.end !== undefined && c.end !== day) throw writeError("unsupported", "An all-day event covers one day: leave end out or give the same date.");
      startMs = zonedToEpoch(day, "00:00", timeZone);
      endMs = zonedToEpoch(addDays(day, 1), "00:00", timeZone);
      body.starts_at = day;
      body.ends_at = addDays(day, 1);
      changes.start = day;
      changes.end = addDays(day, 1);
      expect.readDates.push(day);
    } else {
      startMs = c.start !== undefined ? localToEpoch(c.start as string, timeZone, "start") : Date.parse(String(a.starts_at));
      endMs = c.end !== undefined ? localToEpoch(c.end as string, timeZone, "end") : Date.parse(String(a.ends_at));
      if (endMs <= startMs) throw writeError("end_before_start", "end must be after start.");
      if (found.kind === "series" && (dateInZone(startMs, timeZone) !== raw.date || dateInZone(endMs - 1, timeZone) !== raw.date)) {
        throw writeError("unsupported", `A time change on a repeating event keeps its date (${raw.date as string}): only the time of day changes.`);
      }
      body.starts_at = isoWithOffset(startMs, timeZone);
      body.ends_at = isoWithOffset(endMs, timeZone);
      changes.start = body.starts_at as string;
      changes.end = body.ends_at as string;
      expect.readDates.push(dateInZone(startMs, timeZone));
    }
    if (found.kind === "series") body.timezone = timeZone;
    expect.startMs = startMs;
    expect.endMs = endMs;
  }
  if (c.allDay !== undefined) {
    body.all_day = allDay;
    changes.allDay = allDay;
    expect.allDay = allDay;
  }
  if (c.location !== undefined) {
    const v = optionalText(c.location, "location", LOCATION_MAX);
    body.location = v ?? "";
    changes.location = v;
    expect.location = v;
  }
  if (c.notes !== undefined) {
    const v = optionalText(c.notes, "notes", NOTES_MAX);
    body.description = v ?? "";
    changes.notes = v;
    expect.notes = v;
  }

  // People and labels: the app re-sends the whole set with every edit. Keep what is not being changed,
  // including the label Skylight puts on a Google calendar's events.
  const categories = await getCategories(false);
  const byId = new Map(categories.map((x) => [String(x.id), x]));
  const current = categoryIdsOf(found.event);
  const currentProfiles = current.filter((id) => byId.get(id)?.attributes.linked_to_profile === true);
  const currentLabels = current.filter((id) => byId.get(id)?.attributes.linked_to_profile !== true);
  let profiles = currentProfiles;
  let labels = currentLabels;
  if (c.profileIds !== undefined) {
    profiles = idList(c.profileIds, "profileIds");
    const bad = profiles.filter((id) => byId.get(id)?.attributes.linked_to_profile !== true);
    if (bad.length) throw writeError("unknown_profile", "Not a profile on this frame: see profiles.list().", { ids: bad });
    changes.profileIds = profiles;
  }
  if (c.labelIds !== undefined) {
    labels = idList(c.labelIds, "labelIds");
    const unknown = labels.filter((id) => {
      const x = byId.get(id);
      return !x || x.attributes.linked_to_profile === true;
    });
    if (unknown.length) throw writeError("unknown_label", "Not a label on this frame: see labels.list().", { ids: unknown });
    const fed = labels.filter((id) => !currentLabels.includes(id) && (byId.get(id)?.relationships?.source_calendars?.data ?? []).length > 0);
    if (fed.length) throw writeError("label_not_assignable", "A synced calendar writes to this label; Skylight assigns it itself.", { ids: fed });
    changes.labelIds = labels;
  }
  body.category_ids = [...profiles, ...labels];
  expect.categoryIds = [...profiles, ...labels];

  const title = typeof a.summary === "string" ? a.summary : "this event";
  const effect =
    found.kind === "series"
      ? scope === "one"
        ? `only the occurrence on ${raw.date as string}; it becomes its own event with a new id`
        : `the whole series "${title}", every occurrence, including ones edited on their own`
      : found.kind === "detached"
        ? `this occurrence of "${title}", which was already edited on its own`
        : `"${title}"`;
  return { found, scope, body, changes, effect, expect };
}

function matchesExpect(event: CalendarEventResource, expect: UpdatePlan["expect"], categoryIdsOf: (e: CalendarEventResource) => string[]): boolean {
  const a = event.attributes as Record<string, unknown>;
  if (expect.title !== undefined && a.summary !== expect.title) return false;
  if (expect.startMs !== undefined && Date.parse(String(a.starts_at)) !== expect.startMs) return false;
  if (expect.endMs !== undefined && Date.parse(String(a.ends_at)) !== expect.endMs) return false;
  if (expect.allDay !== undefined && (a.all_day === true) !== expect.allDay) return false;
  if (expect.location !== undefined && !sameText(a.location, expect.location)) return false;
  if (expect.notes !== undefined && !sameText(a.description, expect.notes)) return false;
  const stored = new Set(categoryIdsOf(event));
  return expect.categoryIds.every((id) => stored.has(id));
}

/**
 * Update, then read back. Resolves with the event as stored, under its id after the change: an edit
 * of one occurrence makes a new event, and a time edit of a series changes every occurrence's id.
 */
export async function commitUpdate(input: unknown, timeZone: string, categoryIdsOf: (e: CalendarEventResource) => string[]): Promise<CalendarEventResource> {
  const plan = await planUpdate(input, timeZone, categoryIdsOf);
  const id = String(plan.found.event.id);
  let failure: unknown = null;
  try {
    await updateCalendarEvent(id, plan.body as never, plan.scope ?? undefined);
  } catch (error) {
    failure = mapWriteFailure(error);
  }
  const key = seriesKeyOf(plan.found.event);
  const dates = [...new Set(plan.expect.readDates)].sort();
  const pick = (list: CalendarEventResource[]): CalendarEventResource | undefined => {
    const fits = (e: CalendarEventResource) => matchesExpect(e, plan.expect, categoryIdsOf);
    if (plan.found.kind !== "series") return list.find((e) => String(e.id) === id && fits(e));
    if (plan.scope === "one") {
      // The split-off occurrence: a plain id, pointing back at the series.
      return list.find((e) => {
        const m = (e.attributes as Record<string, unknown>).master_event_id;
        return m != null && (String(m) === key.uid || String(m) === key.number) && fits(e);
      });
    }
    // Whole series: the occurrence on this date, same series.
    return list.find((e) => String(e.id).split("-")[0] === key.number && fits(e));
  };
  const readBack = () =>
    readBackUntil(() => getCalendarEvents({ dateMin: dates[0]!, dateMax: dates[dates.length - 1]!, timezone: timeZone }), (list) => pick(list) !== undefined);
  if (failure) return settleUnknown(failure, "the calendar", async () => pick((await readBack()).value));
  const back = await afterWrite(id, "the calendar", readBack);
  const stored = pick(back.value);
  if (!back.ok || !stored) {
    throw writeError("not_confirmed", "Skylight accepted the change but reading it back did not show it as asked. Read the calendar before trying again.", { eventId: id });
  }
  return stored;
}

interface DeletePlan {
  found: Found;
  scope: "one" | "future" | "all" | null;
  effect: string;
  date: string;
}

/** The one check behind previewDelete and delete. It only reads; a failed read is `read_failed`. */
export function planDelete(input: unknown, timeZone: string, categoryIdsOf: (e: CalendarEventResource) => string[]): Promise<DeletePlan> {
  return asRead(() => planDeleteInner(input, timeZone, categoryIdsOf));
}

async function planDeleteInner(input: unknown, timeZone: string, categoryIdsOf: (e: CalendarEventResource) => string[]): Promise<DeletePlan> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw writeError("bad_input", "delete needs an object: id, date, version.");
  const raw = input as Record<string, unknown>;
  if (raw.scope !== undefined && raw.scope !== "one" && raw.scope !== "future" && raw.scope !== "all") {
    throw writeError("bad_input", 'scope must be "one", "future" or "all".');
  }
  const found = await findForWrite(raw, DELETE_KEYS, timeZone, categoryIdsOf, "deleted");
  const scope = (raw.scope as DeletePlan["scope"] | undefined) ?? null;
  if (found.kind === "series" && scope === null) {
    throw writeError("scope_required", 'That is an occurrence of a repeating event: say scope "one", "future" (this and every later one) or "all" (the whole series).');
  }
  if (found.kind !== "series" && scope !== null) throw writeError("scope_not_allowed", "scope applies to an occurrence of a repeating event only.");
  const a = found.event.attributes as Record<string, unknown>;
  const title = typeof a.summary === "string" ? a.summary : "this event";
  const date = raw.date as string;
  const effect =
    scope === "one" ? `only the occurrence of "${title}" on ${date}`
    : scope === "future" ? `"${title}" on ${date} and every later occurrence`
    : scope === "all" ? `the whole series "${title}", every occurrence past and future, including ones edited on their own`
    : found.kind === "detached" ? `this occurrence of "${title}", which was edited on its own (the rest of the series stays)`
    : `"${title}"`;
  return { found, scope, effect, date };
}

/** Delete, then read the date back until the event is gone. */
export async function commitDelete(input: unknown, timeZone: string, categoryIdsOf: (e: CalendarEventResource) => string[]): Promise<{ deleted: true; id: string; scope: DeletePlan["scope"] }> {
  const plan = await planDelete(input, timeZone, categoryIdsOf);
  const id = String(plan.found.event.id);
  try {
    // An occurrence edited on its own is deleted by its own id with no scope, as the app does.
    await deleteCalendarEvent(id, plan.scope ?? undefined);
  } catch (error) {
    const failure = mapWriteFailure(error);
    return settleUnknown(failure, "the calendar", async () => {
      const gone = await readBackUntil(() => getCalendarEvents({ dateMin: plan.date, dateMax: plan.date, timezone: timeZone }), (list) => !list.some((e) => String(e.id) === id));
      return gone.ok ? { deleted: true as const, id, scope: plan.scope } : undefined;
    });
  }
  const back = await afterWrite(id, "the calendar", () =>
    readBackUntil(() => getCalendarEvents({ dateMin: plan.date, dateMax: plan.date, timezone: timeZone }), (list) => !list.some((e) => String(e.id) === id))
  );
  if (!back.ok) throw writeError("not_confirmed", "Skylight accepted the delete but the event still shows on reading it back. Read the calendar before trying again.", { eventId: id });
  return { deleted: true, id, scope: plan.scope };
}
