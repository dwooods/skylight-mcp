/**
 * The breakage canary's checks: read-only calls through the library entry, each judged
 * against what the family's data must look like. Skylight has no official API, so the
 * common breakage is a wrong or empty result, not an HTTP error.
 *
 * A result carries only a fixed check id and a fixed reason word. Nothing Skylight returns
 * (a title, a name, an error message) is ever copied into a result, because the result is
 * sent to a third-party alert service.
 */

import type { Skylight } from "../lib.js";
import { AuthenticationError } from "../utils/errors.js";

export type CheckId = "profiles" | "meal-categories" | "meals-week" | "calendar-week" | "calendar-sources";
export type Reason = "sign-in" | "error" | "empty" | "shape" | "no-dinner";

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  reason?: Reason;
}

export interface CheckInput {
  /** First and last day of the window, YYYY-MM-DD. */
  from: string;
  to: string;
  /** The meal category that must exist. */
  dinnerName: string;
}

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const isArray = (v: unknown): v is Array<Record<string, unknown>> =>
  Array.isArray(v) && v.every((x) => x !== null && typeof x === "object");

type Verdict = Reason | null;

async function attempt(id: CheckId, fn: () => Promise<Verdict>): Promise<CheckResult> {
  try {
    const reason = await fn();
    return reason ? { id, ok: false, reason } : { id, ok: true };
  } catch (error) {
    return { id, ok: false, reason: error instanceof AuthenticationError ? "sign-in" : "error" };
  }
}

export async function runChecks(skylight: Skylight, input: CheckInput): Promise<CheckResult[]> {
  const range = { from: input.from, to: input.to };
  return Promise.all([
    attempt("profiles", async () => {
      const list: unknown = await skylight.profiles.list();
      if (!isArray(list)) return "shape";
      if (list.length === 0) return "empty";
      return list.every((p) => nonEmpty(p.id) && nonEmpty(p.label)) ? null : "shape";
    }),
    attempt("meal-categories", async () => {
      const list: unknown = await skylight.meals.categories();
      if (!isArray(list)) return "shape";
      if (list.length === 0) return "empty";
      if (!list.every((c) => nonEmpty(c.id) && nonEmpty(c.name))) return "shape";
      const wanted = input.dinnerName.trim().toLowerCase();
      return list.some((c) => String(c.name).trim().toLowerCase() === wanted) ? null : "no-dinner";
    }),
    attempt("meals-week", async () => {
      // An empty week is allowed: a family may not have planned it. A malformed one is not.
      const list: unknown = await skylight.meals.sittings(range);
      if (!isArray(list)) return "shape";
      return list.every((m) => nonEmpty(m.id) && Array.isArray(m.dates) && m.dates.length > 0 && m.dates.every(nonEmpty))
        ? null
        : "shape";
    }),
    attempt("calendar-week", async () => {
      const list: unknown = await skylight.calendar.events(range);
      if (!isArray(list)) return "shape";
      if (list.length === 0) return "empty";
      return list.every((e) => nonEmpty(e.id) && typeof e.title === "string" && (e.start === null || nonEmpty(e.start)))
        ? null
        : "shape";
    }),
    attempt("calendar-sources", async () => {
      const list: unknown = await skylight.calendar.sources();
      if (!isArray(list)) return "shape";
      if (list.length === 0) return "empty";
      return list.every((s) => nonEmpty(s.id) && nonEmpty(s.kind)) ? null : "shape";
    }),
  ]);
}

/** One line for the alert. Fixed words only. Sign-in problems collapse to one reason. */
export function summarize(results: readonly CheckResult[]): { ok: boolean; message: string } {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return { ok: true, message: `all ${results.length} checks passed` };
  if (failed.every((r) => r.reason === "sign-in")) return { ok: false, message: "FAILED: sign-in needed" };
  return { ok: false, message: `FAILED: ${failed.map((r) => `${r.id}:${r.reason}`).join(", ")}` };
}
