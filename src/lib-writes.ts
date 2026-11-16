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
import { getCalendarEvents, createCalendarEvent } from "./api/endpoints/calendar.js";
import { getCategories } from "./api/endpoints/categories.js";
import { isoWithOffset } from "./api/endpoints/messages.js";
import { readBackUntil } from "./api/endpoints/source-calendars.js";
import type { CalendarEventResource, CategoryResource, CreateCalendarEventRequest, SourceCalendarResource } from "./api/types.js";
import { addDays, dateInZone, toLocalParts, zonedToEpoch } from "./utils/schedule.js";

export type WriteErrorCode =
  | "bad_input"
  | "invalid_title"
  | "invalid_time"
  | "end_before_start"
  | "unknown_profile"
  | "unknown_label"
  | "label_not_assignable"
  | "unknown_calendar"
  | "calendar_not_writable"
  | "unsupported"
  | "skylight_refused"
  | "outcome_unknown"
  | "not_confirmed";

export interface SkylightWriteError extends Error {
  name: "SkylightWriteError";
  code: WriteErrorCode;
  /** HTTP status, for `skylight_refused` only. */
  status?: number;
  /** The id Skylight gave the event, for `not_confirmed` only. */
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
}

const CREATE_KEYS = new Set(["title", "start", "end", "allDay", "location", "notes", "profileIds", "labelIds", "calendar"]);
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
}

/** The one check behind previewCreate and create. Reads categories and calendars fresh every time. */
export async function planCreate(input: unknown, timeZone: string): Promise<CreatePlan> {
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
    const cal = (await sourcesWithAccounts()).find((c) => String(c.id) === raw.calendar);
    if (!cal) throw writeError("unknown_calendar", "No synced calendar with that id: see calendar.sources().");
    const a = cal.attributes as Record<string, unknown>;
    if (!sourceWritable(cal)) throw writeError("calendar_not_writable", "That calendar is not a Google calendar this account can write to.");
    const sourceId = typeof a.source_id === "string" ? a.source_id : "";
    const account = (cal.relationships as { calendar_account?: { data?: { id?: unknown } | null } } | undefined)?.calendar_account?.data?.id;
    if (!sourceId || !((typeof account === "string" && account !== "") || typeof account === "number")) {
      throw writeError("calendar_not_writable", "Skylight did not report that calendar's account, so it cannot be written to.");
    }
    const label = typeof a.label === "string" && !EMAIL.test(a.label) ? a.label : "Google calendar";
    target = { calendarId: sourceId, accountId: account, label, id: String(cal.id) };
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
  };
  return { preview, body, startDate, endDate, startMs, endMs, categoryIds, source: target ? "google" : "skylight" };
}

/** Map anything the write itself threw to the library's own error, never Skylight's text. Sign-in errors pass through. */
function mapWriteFailure(error: unknown): unknown {
  const e = error as { name?: string; statusCode?: number } | null;
  if (e && (e.name === "AuthenticationError" || e.name === "CredentialSaveError")) return error;
  const status = typeof e?.statusCode === "number" ? e.statusCode : undefined;
  if (status !== undefined && status >= 400 && status < 500) {
    return writeError("skylight_refused", `Skylight refused the write (HTTP ${status}). Nothing was written.`, { status });
  }
  return writeError("outcome_unknown", "The write was sent but no answer came back (a network error or a Skylight server error). It may or may not have been written: read the calendar before trying again.");
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
  categoryIdsOf: (e: CalendarEventResource) => string[]
): Promise<CalendarEventResource> {
  const plan = await planCreate(input, timeZone);
  let created: CalendarEventResource;
  try {
    created = await createCalendarEvent(plan.body);
  } catch (error) {
    throw mapWriteFailure(error);
  }
  const id = created?.id !== undefined && created?.id !== null ? String(created.id) : "";
  if (!id) throw writeError("outcome_unknown", "Skylight accepted the write but did not say which event it created. Read the calendar before trying again.");
  const back = await readBackUntil(
    () => getCalendarEvents({ dateMin: plan.startDate, dateMax: plan.endDate, timezone: timeZone }),
    (list) => list.some((e) => String(e.id) === id && matchesPlan(e, plan, categoryIdsOf))
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
