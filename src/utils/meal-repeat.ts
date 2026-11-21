/**
 * Meal repeat rules, as Skylight's Plan Meal form sets them (captured 2026-11-20, web app):
 * every N day / week / month / year; for weeks, a set of weekdays; for months, the day of the
 * month or the nth weekday, both taken from the start date; an optional inclusive end date.
 *
 * Skylight stores a meal rule as a plain RRULE string (no "RRULE:" prefix, not an array). The
 * app sends an end as `UNTIL=<yyyymmdd>T235959Z`; Skylight stores it as `UNTIL=<yyyymmdd>` moved
 * to the end, and keeps a rule without an end exactly as sent. So rules are compared by their
 * parsed parts, never as text.
 */

export type Weekday = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA";
export const WEEKDAYS: readonly Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** A rule the library can describe. `until` is inclusive, null when open-ended. */
export interface MealRepeat {
  every: "day" | "week" | "month" | "year";
  interval: number;
  /** Weeks only, in Sunday-first order. */
  weekdays?: Weekday[];
  /** Months only. */
  monthlyOn?: "date" | "weekday";
  until: string | null;
}

/** A stored rule that uses parts the library does not model (a count, several months, ...). */
export interface OtherRepeat {
  every: "other";
}

/** A fixed-code note about a rule, for importers that show their own wording. */
export interface RepeatNotice {
  code: "skips_months";
  /** Month numbers (1-12) in which the rule has no day, so no meal that month. */
  months: number[];
}

export const INTERVAL_MAX = 99;
export const OCCURRENCES_SHOWN = 5;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export class RepeatInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepeatInputError";
  }
}

function utc(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isRealDate(s: unknown): s is string {
  return typeof s === "string" && DATE.test(s) && iso(utc(s)) === s;
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[new Date(utc(date)).getUTCDay()]!;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Which nth weekday of its month a date is (1-5). */
function nthOf(date: string): number {
  return Math.ceil(Number(date.slice(8, 10)) / 7);
}

/**
 * Check and normalise a `repeat` input for a meal starting on `date`. `"weekly"` keeps its old
 * meaning (every week on date's weekday, no end). Every refusal throws RepeatInputError, which the
 * library reports as `invalid_repeat`.
 */
export function normalizeRepeat(input: unknown, date: string): MealRepeat {
  if (input === "weekly") return { every: "week", interval: 1, weekdays: [weekdayOf(date)], until: null };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RepeatInputError('repeat must be "weekly" or { every, interval?, weekdays?, monthlyOn?, until? }.');
  }
  const raw = input as Record<string, unknown>;
  const allowed = new Set(["every", "interval", "weekdays", "monthlyOn", "until"]);
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length) throw new RepeatInputError(`Unknown repeat field(s): ${unknown.join(", ")}.`);

  const every = raw.every;
  if (every !== "day" && every !== "week" && every !== "month" && every !== "year") {
    throw new RepeatInputError('repeat.every must be "day", "week", "month" or "year".');
  }
  const interval = raw.interval === undefined ? 1 : raw.interval;
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1 || interval > INTERVAL_MAX) {
    throw new RepeatInputError(`repeat.interval must be a whole number from 1 to ${INTERVAL_MAX}.`);
  }
  let until: string | null = null;
  if (raw.until !== undefined && raw.until !== null) {
    if (!isRealDate(raw.until)) throw new RepeatInputError("repeat.until must be a date, YYYY-MM-DD.");
    if (raw.until < date) throw new RepeatInputError("repeat.until is before the meal's date.");
    until = raw.until;
  }

  if (raw.weekdays !== undefined && every !== "week") throw new RepeatInputError('repeat.weekdays is for every: "week" only.');
  if (raw.monthlyOn !== undefined && every !== "month") throw new RepeatInputError('repeat.monthlyOn is for every: "month" only.');

  const out: MealRepeat = { every, interval, until };
  if (every === "week") {
    let days: Weekday[] = [weekdayOf(date)];
    if (raw.weekdays !== undefined) {
      const list = raw.weekdays;
      if (!Array.isArray(list) || list.length === 0) throw new RepeatInputError("repeat.weekdays must be a non-empty list such as [\"MO\", \"WE\"].");
      if (list.some((d) => !WEEKDAYS.includes(d as Weekday))) throw new RepeatInputError("repeat.weekdays takes SU, MO, TU, WE, TH, FR, SA.");
      if (new Set(list).size !== list.length) throw new RepeatInputError("repeat.weekdays lists a day twice.");
      if (!list.includes(weekdayOf(date))) throw new RepeatInputError(`repeat.weekdays must include the meal's own weekday (${weekdayOf(date)}).`);
      days = WEEKDAYS.filter((d) => list.includes(d));
    }
    out.weekdays = days;
  }
  if (every === "month") {
    const monthlyOn = raw.monthlyOn === undefined ? "date" : raw.monthlyOn;
    if (monthlyOn !== "date" && monthlyOn !== "weekday") throw new RepeatInputError('repeat.monthlyOn must be "date" or "weekday".');
    out.monthlyOn = monthlyOn;
  }
  return out;
}

/** The rule as the app sends it for this start date (the end, when there is one, as T235959Z). */
export function buildRrule(r: MealRepeat, date: string): string {
  const until = r.until ? `;UNTIL=${r.until.replace(/-/g, "")}T235959Z` : "";
  switch (r.every) {
    case "day":
      return `FREQ=DAILY;INTERVAL=${r.interval}${until}`;
    case "week":
      return `FREQ=WEEKLY;INTERVAL=${r.interval}${until};WKST=SU;BYDAY=${(r.weekdays ?? [weekdayOf(date)]).join(",")}`;
    case "month":
      return r.monthlyOn === "weekday"
        ? `FREQ=MONTHLY;INTERVAL=${r.interval}${until};BYSETPOS=${nthOf(date)};BYDAY=${weekdayOf(date)}`
        : `FREQ=MONTHLY;INTERVAL=${r.interval}${until};BYMONTHDAY=${Number(date.slice(8, 10))}`;
    case "year":
      return `FREQ=YEARLY;INTERVAL=${r.interval}${until}`;
  }
}

/**
 * Read a stored rule. Anything outside what the form can set (COUNT, BYMONTH, a BYDAY with a
 * number, several month days, an hourly rule, an UNTIL that is not a date) is `{ every: "other" }`.
 */
export function parseRrule(rule: string | null | undefined): MealRepeat | OtherRepeat | null {
  if (!rule) return null;
  const parts = new Map<string, string>();
  for (const piece of rule.replace(/^RRULE:/i, "").split(";")) {
    if (!piece) continue;
    const at = piece.indexOf("=");
    if (at < 1) return { every: "other" };
    const key = piece.slice(0, at).toUpperCase();
    if (parts.has(key)) return { every: "other" };
    parts.set(key, piece.slice(at + 1));
  }
  const other: OtherRepeat = { every: "other" };
  const freq = parts.get("FREQ");
  const every = freq === "DAILY" ? "day" : freq === "WEEKLY" ? "week" : freq === "MONTHLY" ? "month" : freq === "YEARLY" ? "year" : null;
  if (!every) return other;
  const known = new Set(["FREQ", "INTERVAL", "UNTIL", "WKST", "BYDAY", "BYMONTHDAY", "BYSETPOS"]);
  if ([...parts.keys()].some((k) => !known.has(k))) return other;

  const intervalText = parts.get("INTERVAL") ?? "1";
  if (!/^\d{1,3}$/.test(intervalText)) return other;
  const interval = Number(intervalText);
  if (interval < 1) return other;

  let until: string | null = null;
  const u = parts.get("UNTIL");
  if (u !== undefined) {
    const m = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(u);
    if (!m) return other;
    until = `${m[1]}-${m[2]}-${m[3]}`;
    if (!isRealDate(until)) return other;
  }
  const wkst = parts.get("WKST");
  if (wkst !== undefined && wkst !== "SU") return other;

  const byday = parts.get("BYDAY");
  const bymonthday = parts.get("BYMONTHDAY");
  const bysetpos = parts.get("BYSETPOS");
  const out: MealRepeat = { every, interval, until };
  if (every === "week") {
    if (bymonthday !== undefined || bysetpos !== undefined) return other;
    if (byday === undefined) return other;
    const days = byday.split(",");
    if (days.some((d) => !WEEKDAYS.includes(d as Weekday)) || new Set(days).size !== days.length) return other;
    out.weekdays = WEEKDAYS.filter((d) => days.includes(d));
  } else if (every === "month") {
    if (bymonthday !== undefined && byday === undefined && bysetpos === undefined && /^\d{1,2}$/.test(bymonthday)) {
      out.monthlyOn = "date";
    } else if (bymonthday === undefined && bysetpos !== undefined && /^[1-5]$/.test(bysetpos) && byday !== undefined && WEEKDAYS.includes(byday as Weekday)) {
      out.monthlyOn = "weekday";
    } else {
      return other;
    }
  } else if (byday !== undefined || bymonthday !== undefined || bysetpos !== undefined) {
    return other;
  }
  return out;
}

/**
 * Whether a stored rule says what was asked, by parts. For a month rule the stored day or nth
 * weekday must also be the one the start date gives, since the input takes both from the date.
 */
export function sameRepeat(stored: string | null | undefined, asked: MealRepeat, date: string): boolean {
  const s = parseRrule(stored);
  if (!s || s.every === "other") return false;
  const a = asked;
  if (s.every !== a.every || s.interval !== a.interval || s.until !== a.until) return false;
  if (a.every === "week") return (s.weekdays ?? []).join(",") === (a.weekdays ?? []).join(",");
  if (a.every === "month") {
    if (s.monthlyOn !== a.monthlyOn) return false;
    // Same mode is not enough: the day must match too.
    const rule = (stored ?? "").toUpperCase();
    return a.monthlyOn === "date"
      ? new RegExp(`(^|;)BYMONTHDAY=${Number(date.slice(8, 10))}(;|$)`).test(rule)
      : new RegExp(`(^|;)BYSETPOS=${nthOf(date)}(;|$)`).test(rule) && new RegExp(`(^|;)BYDAY=${weekdayOf(date)}(;|$)`).test(rule);
  }
  return true;
}

/** The day a month rule lands on in a given month, or null when that month has none. */
function monthDay(r: MealRepeat, start: string, year: number, month: number): number | null {
  if (r.monthlyOn === "weekday") {
    const n = nthOf(start);
    const target = WEEKDAYS.indexOf(weekdayOf(start));
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const day = 1 + ((target - firstDow + 7) % 7) + (n - 1) * 7;
    return day <= daysInMonth(year, month) ? day : null;
  }
  const d = Number(start.slice(8, 10));
  return d <= daysInMonth(year, month) ? d : null;
}

/**
 * Expand the rule from its start date, in order, up to `limit` dates (and never past `until`).
 * Months and years without the day are skipped, as Skylight does (RFC 5545): the 31st has no
 * meal in a 30-day month, Feb 29 none in other years.
 */
export function expand(r: MealRepeat, start: string, limit: number, hardStop = 50_000): string[] {
  const out: string[] = [];
  const end = r.until ? utc(r.until) : Infinity;
  const push = (ms: number) => {
    if (ms >= utc(start) && ms <= end && out.length < limit) out.push(iso(ms));
  };
  const y0 = Number(start.slice(0, 4));
  const m0 = Number(start.slice(5, 7));
  let steps = 0;
  if (r.every === "day") {
    for (let ms = utc(start); ms <= end && out.length < limit && steps++ < hardStop; ms += r.interval * DAY_MS) push(ms);
  } else if (r.every === "week") {
    const sunday0 = utc(start) - new Date(utc(start)).getUTCDay() * DAY_MS;
    const offsets = (r.weekdays ?? [weekdayOf(start)]).map((d) => WEEKDAYS.indexOf(d));
    for (let week = sunday0; week <= end && out.length < limit && steps++ < hardStop; week += r.interval * 7 * DAY_MS) {
      for (const o of offsets) push(week + o * DAY_MS);
    }
  } else if (r.every === "month") {
    for (let k = 0; out.length < limit && steps++ < hardStop; k += r.interval) {
      const y = y0 + Math.floor((m0 - 1 + k) / 12);
      const m = ((m0 - 1 + k) % 12) + 1;
      if (Date.UTC(y, m - 1, 1) > end) break;
      const d = monthDay(r, start, y, m);
      if (d !== null) push(Date.UTC(y, m - 1, d));
    }
  } else {
    const md = start.slice(5);
    for (let y = y0; out.length < limit && steps++ < hardStop; y += r.interval) {
      if (Date.UTC(y, 0, 1) > end) break;
      const candidate = `${y}-${md}`;
      if (isRealDate(candidate)) push(utc(candidate));
    }
  }
  return out;
}

/** The first few dates and, when the rule ends, the last one. */
export function occurrences(r: MealRepeat, start: string): { first: string[]; last: string | null } {
  const first = expand(r, start, OCCURRENCES_SHOWN);
  if (!r.until) return { first, last: null };
  const all = expand(r, start, Number.MAX_SAFE_INTEGER);
  return { first, last: all.length ? all[all.length - 1]! : null };
}

/**
 * A note when the rule skips whole months (the 29th to 31st, or a 5th weekday): the months, among
 * the rule's own months in the first year from the start, that have no such day.
 */
export function repeatNotices(r: MealRepeat, start: string): RepeatNotice[] {
  if (r.every !== "month") return [];
  const y0 = Number(start.slice(0, 4));
  const m0 = Number(start.slice(5, 7));
  const months: number[] = [];
  for (let k = 0; k < 12; k += r.interval) {
    const y = y0 + Math.floor((m0 - 1 + k) / 12);
    const m = ((m0 - 1 + k) % 12) + 1;
    if (monthDay(r, start, y, m) === null) months.push(m);
  }
  return months.length ? [{ code: "skips_months", months }] : [];
}

const DAY_NAMES: Record<Weekday, string> = { SU: "Sun", MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat" };

/** Plain words for a rule, for tool output, e.g. "every 2 weeks on Mon, Wed until 2027-12-20". */
export function describeRepeat(r: MealRepeat | OtherRepeat): string {
  if (r.every === "other") return "repeats (a rule this server does not describe)";
  const n = r.interval;
  const unit = r.every;
  let text = n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
  if (unit === "week") text += ` on ${(r.weekdays ?? []).map((d) => DAY_NAMES[d]).join(", ")}`;
  if (unit === "month") text += r.monthlyOn === "weekday" ? " on the same weekday of the month (e.g. the 1st Monday)" : " on the same day of the month";
  return r.until ? `${text} until ${r.until}` : text;
}
