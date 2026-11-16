/**
 * Repeating-series rules for the library's event create (daily, weekly, monthly, yearly).
 *
 * Every rule shape here was captured from the Skylight web app (skylight-api-findings.md):
 * - daily / weekly: FREQ, INTERVAL, UNTIL, WKST=SU (+ one BYDAY for weekly), as create_calendar_event sends
 * - monthly by date: FREQ=MONTHLY;INTERVAL;[UNTIL];BYMONTHDAY=d
 * - monthly by weekday: FREQ=MONTHLY;INTERVAL;[UNTIL];BYSETPOS=n;BYDAY=XX
 * - yearly: FREQ=YEARLY;INTERVAL;[UNTIL] (the date comes from the start)
 * COUNT is never sent: a count becomes the UNTIL of the last occurrence. UNTIL is the end of the UTC
 * day on which the last occurrence starts, so it is included and the next one is not.
 *
 * Skylight skips a month that has no such day (the 31st in April, a 5th Tuesday) and a year without
 * Feb 29; nothing is moved. The plan lists what is skipped so a preview can say so.
 */

import { addDays, zonedToEpoch } from "./schedule.js";

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINAL = ["", "1st", "2nd", "3rd", "4th", "5th"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SeriesInput {
  every: "day" | "week" | "month" | "year";
  interval?: number;
  /** Monthly only: "date" (the start's day of the month, the default) or "weekday" (e.g. the 3rd Tuesday). */
  monthlyOn?: "date" | "weekday";
  /** Last day a series may land on, YYYY-MM-DD. */
  until?: string;
  /** Number of occurrences. Give until or count, not both. */
  count?: number;
}

export interface SeriesPlan {
  rrule: string;
  /** Plain-words rule, e.g. "every month on the 31st, until 2027-06-30". */
  rule: string;
  /** The first occurrences' dates (up to 12). */
  first: string[];
  /** Months (YYYY-MM) or years (YYYY) the rule skips, within the series or, if open-ended, the next 2 years (monthly) or 8 years (yearly). */
  skipped: string[];
  /** One sentence per thing the person may not expect. */
  warnings: string[];
  /** Date of the last occurrence, or null for an open-ended series. */
  last: string | null;
}

export class SeriesError extends Error {}

const LIMITS = {
  day: { interval: 30, needsEnd: true },
  week: { interval: 12, needsEnd: true },
  month: { interval: 12, needsEnd: false },
  year: { interval: 10, needsEnd: false },
} as const;
const MAX_COUNT = 120;
const DAY_WEEK_SPAN_DAYS = 731;
const MONTH_YEAR_SPAN_YEARS = 10;

function ymd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function dow(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function nthWeekday(y: number, m: number, weekday: number, n: number): number | null {
  const first = dow(y, m, 1);
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return day <= daysIn(y, m) ? day : null;
}
function ordinalDay(d: number): string {
  const s = d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th";
  return `${d}${s}`;
}
function utcDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Plan a series that starts on `startDate` at `startTime` ("HH:MM", or "00:00" for all day) in `timeZone`.
 * Throws SeriesError with a message that says what to change.
 */
export function planSeries(input: unknown, startDate: string, startTime: string, timeZone: string): SeriesPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SeriesError("repeat must be an object.");
  const raw = input as Record<string, unknown>;
  const known = new Set(["every", "interval", "monthlyOn", "until", "count"]);
  for (const k of Object.keys(raw)) if (!known.has(k)) throw new SeriesError(`Unknown repeat field "${k}".`);
  const every = raw.every;
  if (every !== "day" && every !== "week" && every !== "month" && every !== "year") {
    throw new SeriesError('repeat.every must be "day", "week", "month" or "year".');
  }
  const limit = LIMITS[every];
  const interval = raw.interval === undefined ? 1 : raw.interval;
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1 || interval > limit.interval) {
    throw new SeriesError(`repeat.interval must be a whole number from 1 to ${limit.interval}.`);
  }
  if (raw.monthlyOn !== undefined && every !== "month") throw new SeriesError("repeat.monthlyOn applies to monthly series only.");
  if (raw.monthlyOn !== undefined && raw.monthlyOn !== "date" && raw.monthlyOn !== "weekday") {
    throw new SeriesError('repeat.monthlyOn must be "date" or "weekday".');
  }
  const monthlyOn = raw.monthlyOn === "weekday" ? "weekday" : "date";
  const hasUntil = raw.until !== undefined;
  const hasCount = raw.count !== undefined;
  if (hasUntil && hasCount) throw new SeriesError("Give repeat.until or repeat.count, not both.");
  if (limit.needsEnd && !hasUntil && !hasCount) {
    throw new SeriesError(`A ${every === "day" ? "daily" : "weekly"} series needs an end: repeat.until (YYYY-MM-DD) or repeat.count.`);
  }
  if (hasUntil && (typeof raw.until !== "string" || !DATE_RE.test(raw.until))) throw new SeriesError("repeat.until must be YYYY-MM-DD.");
  if (hasCount && (typeof raw.count !== "number" || !Number.isInteger(raw.count) || raw.count < 1 || raw.count > MAX_COUNT)) {
    throw new SeriesError(`repeat.count must be a whole number from 1 to ${MAX_COUNT}.`);
  }
  const until = hasUntil ? (raw.until as string) : null;
  const count = hasCount ? (raw.count as number) : null;
  if (until !== null && until < startDate) throw new SeriesError("repeat.until is before the start.");

  const [sy, sm, sd] = startDate.split("-").map(Number) as [number, number, number];
  const maxDate =
    every === "day" || every === "week" ? addDays(startDate, DAY_WEEK_SPAN_DAYS) : ymd(sy + MONTH_YEAR_SPAN_YEARS, sm, Math.min(sd, 28));
  if (until !== null && until > maxDate) {
    throw new SeriesError(every === "day" || every === "week" ? `A daily or weekly series is limited to ${DAY_WEEK_SPAN_DAYS} days.` : `A series is limited to ${MONTH_YEAR_SPAN_YEARS} years.`);
  }
  // Open-ended: look ahead far enough to show what is skipped.
  const horizon = until ?? (count !== null ? maxDate : every === "month" ? ymd(sy + 2, sm, Math.min(sd, 28)) : every === "year" ? ymd(sy + 8, sm, Math.min(sd, 28)) : maxDate);

  const weekday = dow(sy, sm, sd);
  const nth = Math.ceil(sd / 7);
  const dates: string[] = [];
  const skipped: string[] = [];
  const stop = (date: string): boolean => date > horizon || (count !== null && dates.length >= count);
  if (every === "day" || every === "week") {
    const step = every === "day" ? interval : 7 * interval;
    for (let date = startDate; !stop(date); date = addDays(date, step)) dates.push(date);
  } else if (every === "month") {
    for (let k = 0; ; k++) {
      const months = sm - 1 + k * interval;
      const y = sy + Math.floor(months / 12);
      const m = (months % 12) + 1;
      if (ymd(y, m, 1) > horizon || (count !== null && dates.length >= count)) break;
      const day = monthlyOn === "date" ? (sd <= daysIn(y, m) ? sd : null) : nthWeekday(y, m, weekday, nth);
      if (day === null) {
        skipped.push(ymd(y, m, 1).slice(0, 7));
        continue;
      }
      const date = ymd(y, m, day);
      if (date > horizon) break;
      dates.push(date);
    }
  } else {
    for (let k = 0; ; k++) {
      const y = sy + k * interval;
      if (ymd(y, 1, 1) > horizon || (count !== null && dates.length >= count)) break;
      if (sd > daysIn(y, sm)) {
        skipped.push(String(y));
        continue;
      }
      const date = ymd(y, sm, sd);
      if (date > horizon) break;
      dates.push(date);
    }
  }
  if (dates.length === 0) throw new SeriesError("That rule has no occurrence on or before repeat.until.");
  if (count !== null && dates.length < count) throw new SeriesError(`That many occurrences go past the ${every === "day" || every === "week" ? `${DAY_WEEK_SPAN_DAYS}-day` : `${MONTH_YEAR_SPAN_YEARS}-year`} limit.`);

  const bounded = until !== null || count !== null;
  const last = bounded ? dates[dates.length - 1]! : null;
  const untilPart = last !== null ? `UNTIL=${utcDate(zonedToEpoch(last, startTime, timeZone))}T235959Z` : null;
  const code = DAY_CODES[weekday]!;
  let rrule: string;
  let rule: string;
  const each = (unit: string): string => (interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`);
  if (every === "day" || every === "week") {
    const parts = [`FREQ=${every === "day" ? "DAILY" : "WEEKLY"}`, `INTERVAL=${interval}`, untilPart!, "WKST=SU"];
    if (every === "week") parts.push(`BYDAY=${code}`);
    rrule = `RRULE:${parts.join(";")}`;
    rule = every === "day" ? each("day") : `${each("week")} on ${DAY_NAMES[weekday]}`;
  } else if (every === "month") {
    const by = monthlyOn === "date" ? [`BYMONTHDAY=${sd}`] : [`BYSETPOS=${nth}`, `BYDAY=${code}`];
    rrule = `RRULE:${["FREQ=MONTHLY", `INTERVAL=${interval}`, ...(untilPart ? [untilPart] : []), ...by].join(";")}`;
    rule = `${each("month")} on the ${monthlyOn === "date" ? ordinalDay(sd) : `${ORDINAL[nth]} ${DAY_NAMES[weekday]}`}`;
  } else {
    rrule = `RRULE:${["FREQ=YEARLY", `INTERVAL=${interval}`, ...(untilPart ? [untilPart] : [])].join(";")}`;
    rule = `${each("year")} on ${startDate.slice(5)}`;
  }
  rule += last !== null ? `, last on ${last}` : ", with no end";

  const warnings: string[] = [];
  if (skipped.length) {
    const what = every === "year" ? "Years without Feb 29 are skipped" : monthlyOn === "date" ? `Months without a ${ordinalDay(sd)} are skipped` : `Months without a ${ORDINAL[nth]} ${DAY_NAMES[weekday]} are skipped`;
    const where = bounded ? "" : every === "year" ? " (next 8 years shown)" : " (next 2 years shown)";
    warnings.push(`${what}, not moved: ${skipped.join(", ")}${where}.`);
  }
  return { rrule, rule, first: dates.slice(0, 12), skipped, warnings, last };
}
