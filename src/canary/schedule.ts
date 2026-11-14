/** Next occurrence of a local wall-clock time (HH:MM) in an IANA zone, strictly after `now`. */

import { addDays, dateInZone, zonedToEpoch } from "../utils/schedule.js";

export function parseClock(raw: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error("CANARY_TIME must be HH:MM, 24-hour.");
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

export function nextRunAt(now: number, clock: string, timeZone: string): number {
  const today = dateInZone(now, timeZone);
  for (let d = 0; d <= 2; d++) {
    const at = zonedToEpoch(addDays(today, d), clock, timeZone);
    if (at > now) return at;
  }
  throw new Error("Could not compute the next run time.");
}
