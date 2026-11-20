/**
 * Meal writes for the library entry (experimental): create, update, delete. Same contract as the
 * event writes in lib-writes.ts: a preview that changes nothing and a commit that re-runs the same
 * plan against fresh reads, writes, then reads back; errors are `SkylightWriteError` with a stable
 * `code` and never carry Skylight's response text.
 *
 * What a meal is not: Skylight gives meals no update stamp, so `version` (lib-meals.ts) is a
 * fingerprint of the fields shown and the rule. A change landing between the re-read and the write
 * is not caught.
 *
 * Refused, with code `unsupported`, because the request shape was never captured:
 * - editing or deleting an occurrence that was edited on its own (a "detached" meal);
 * - scope "one" on a series edit (it would make exactly such a meal, which could then not be changed);
 * - moving an occurrence of a series to another day, and editing a whole series whose start cannot be found.
 */

import { getCategories } from "./api/endpoints/categories.js";
import {
  assertIsoDate,
  createMealSitting,
  deleteMealSitting,
  findSeriesStart,
  getMealCategories,
  listMealSittingsOn,
  mealCategoryName,
  mealKind,
  updateMealSitting,
  type MealKind,
  type MealSittingResource,
} from "./api/endpoints/meals.js";
import { readBackUntil } from "./api/endpoints/source-calendars.js";
import { mapWriteFailure, writeError } from "./lib-writes.js";
import { mealVersion } from "./lib-meals.js";
import { checkMealText } from "./utils/meal-text.js";

export interface CreateMealInput {
  title: string;
  /** YYYY-MM-DD. */
  date: string;
  /** A category id from `meals.categories()`. */
  category: string;
  description?: string;
  note?: string;
  /** Profile ids from `profiles.list()`. */
  profileIds?: string[];
  /** Repeat every week on the weekday of `date`. Only this shape exists. */
  repeat?: "weekly";
}

export interface MealRef {
  id: string;
  /** The date the meal was read on. */
  date: string;
  version: string;
}

export interface UpdateMealInput extends MealRef {
  /** A repeating meal only: "future" (this and every later one) or "all" (the whole series). "one" is not supported yet. */
  scope?: "one" | "future" | "all";
  /** What to change; anything left out stays. `date` moves a one-off meal. */
  changes: { title?: string; category?: string; description?: string; note?: string; profileIds?: string[]; date?: string };
}

export interface DeleteMealInput extends MealRef {
  /** A repeating meal only: "one", "future" or "all". */
  scope?: "one" | "future" | "all";
}

export interface CreateMealPreview {
  action: "create";
  title: string;
  date: string;
  category: { id: string; name: string };
  description: string | null;
  note: string | null;
  profileIds: string[];
  profiles: string[];
  repeat: "weekly" | null;
  warnings: string[];
}

export interface UpdateMealPreview<T> {
  action: "update";
  /** The meal as it is now. */
  meal: T;
  scope: "future" | "all" | null;
  /** The fields that will be written. A cleared text field is null. */
  changes: { title?: string; category?: { id: string; name: string }; description?: string | null; note?: string | null; profileIds?: string[]; profiles?: string[]; date?: string };
  effect: string;
  warnings: string[];
}

export interface DeleteMealPreview<T> {
  action: "delete";
  meal: T;
  scope: "one" | "future" | "all" | null;
  effect: string;
}

const TITLE_MAX = 200;
const TEXT_MAX = 5000;
const ID = /^\d{1,12}$/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const CREATE_KEYS = new Set(["title", "date", "category", "description", "note", "profileIds", "repeat"]);
const UPDATE_KEYS = new Set(["id", "date", "version", "scope", "changes"]);
const DELETE_KEYS = new Set(["id", "date", "version", "scope"]);
const CHANGE_KEYS = new Set(["title", "category", "description", "note", "profileIds", "date"]);

function obj(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw writeError("bad_input", `${what} needs an object.`);
  return value as Record<string, unknown>;
}

function noUnknown(raw: Record<string, unknown>, keys: Set<string>, where = ""): void {
  for (const key of Object.keys(raw)) if (!keys.has(key)) throw writeError("bad_input", `Unknown field "${where}${key}".`);
}

function realDate(value: unknown, field: string): string {
  if (typeof value !== "string") throw writeError("bad_input", `${field} must be a date, YYYY-MM-DD.`);
  try {
    return assertIsoDate(value);
  } catch {
    throw writeError("bad_input", `${field} must be a real calendar date, YYYY-MM-DD.`);
  }
}

function title(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw writeError("invalid_title", "title must be non-empty text.");
  const t = value.trim();
  if (t.length > TITLE_MAX) throw writeError("invalid_title", `title is over ${TITLE_MAX} characters.`);
  if (CONTROL.test(t) || /[\r\n]/.test(t)) throw writeError("invalid_title", "title cannot hold line breaks or control characters.");
  return t;
}

/** Free text: line breaks kept, trimmed at the ends. An empty string clears the field (stored as nothing). */
function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw writeError("bad_input", `${field} must be text.`);
  if (value.length > TEXT_MAX) throw writeError("bad_input", `${field} is over ${TEXT_MAX} characters.`);
  if (CONTROL.test(value)) throw writeError("bad_input", `${field} cannot hold control characters.`);
  return value.trim();
}

function ids(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw writeError("bad_input", `${field} must be a list of ids.`);
  for (const v of value) if (typeof v !== "string" || !ID.test(v)) throw writeError("bad_input", `${field} must hold numeric id strings.`);
  return [...new Set(value as string[])];
}

function sameText(stored: unknown, wanted: string | null): boolean {
  return (typeof stored === "string" ? stored : "").trim() === (wanted ?? "").trim();
}

function textFindings(fields: { summary?: string; note?: string; description?: string }): string[] {
  const found = checkMealText(fields);
  if (found.errors.length > 0) throw writeError("bad_input", found.errors[0]!);
  return found.warnings;
}

interface Refs {
  categories: Map<string, string>;
  /** Profile id -> label, from `profiles.list()`. */
  profiles: Map<string, string>;
}

async function refs(): Promise<Refs> {
  const [cats, all] = await Promise.all([getMealCategories(), getCategories()]);
  const profiles = new Map<string, string>();
  for (const c of all) {
    const label = (c.attributes as { label?: unknown }).label;
    if (c.attributes.linked_to_profile === true && typeof label === "string" && label.trim()) profiles.set(String(c.id), label.trim());
  }
  return { categories: new Map(cats.map((c) => [String(c.id), mealCategoryName(c)])), profiles };
}

function checkCategory(id: unknown, r: Refs): { id: string; name: string } {
  if (typeof id !== "string" || !ID.test(id)) throw writeError("bad_input", "category must be a meal category id from meals.categories().");
  const name = r.categories.get(id);
  if (name === undefined) throw writeError("unknown_meal_category", "No meal category has that id: use an id from meals.categories().", { ids: [id] });
  return { id, name };
}

function checkProfiles(list: string[], r: Refs): void {
  const missing = list.filter((id) => !r.profiles.has(id));
  if (missing.length > 0) throw writeError("unknown_profile", "Some profile ids are not profiles: use ids from profiles.list().", { ids: missing });
}

function profileIdsOf(s: MealSittingResource): string[] {
  return (s.relationships?.profiles?.data ?? []).map((p) => String(p.id));
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

interface CreatePlan {
  preview: CreateMealPreview;
}

export async function planCreateMeal(input: unknown): Promise<CreatePlan> {
  const raw = obj(input, "create");
  noUnknown(raw, CREATE_KEYS);
  const t = title(raw.title);
  const date = realDate(raw.date, "date");
  const description = raw.description === undefined ? null : text(raw.description, "description") || null;
  const note = raw.note === undefined ? null : text(raw.note, "note") || null;
  const profileIds = raw.profileIds === undefined ? [] : ids(raw.profileIds, "profileIds");
  if (raw.repeat !== undefined && raw.repeat !== "weekly") {
    throw writeError("invalid_repeat", 'repeat can only be "weekly" (every week on the weekday of date).');
  }
  const warnings = textFindings({ summary: t, ...(note ? { note } : {}), ...(description ? { description } : {}) });
  const r = await refs();
  const category = checkCategory(raw.category, r);
  checkProfiles(profileIds, r);
  return {
    preview: {
      action: "create",
      title: t,
      date,
      category,
      description,
      note,
      profileIds,
      profiles: profileIds.map((id) => r.profiles.get(id)!),
      repeat: raw.repeat === "weekly" ? "weekly" : null,
      warnings,
    },
  };
}

function matchesCreate(s: MealSittingResource, p: CreateMealPreview): boolean {
  const a = s.attributes;
  if ((typeof a.summary === "string" ? a.summary : "") !== p.title) return false;
  if (!sameText(a.description, p.description) || !sameText(a.note, p.note)) return false;
  if (String(s.relationships?.meal_category?.data?.id ?? "") !== p.category.id) return false;
  if (!sameSet(profileIdsOf(s), p.profileIds)) return false;
  if (p.repeat === "weekly") return typeof a.rrule === "string" && a.rrule.includes("FREQ=WEEKLY");
  return !a.rrule && a.recurring !== true;
}

export async function commitCreateMeal(input: unknown): Promise<MealSittingResource> {
  const { preview: p } = await planCreateMeal(input);
  let created: MealSittingResource;
  try {
    created = await createMealSitting({
      date: p.date,
      mealCategoryId: p.category.id,
      summary: p.title,
      ...(p.description ? { description: p.description } : {}),
      ...(p.note ? { note: p.note } : {}),
      ...(p.profileIds.length > 0 ? { profileIds: p.profileIds } : {}),
      ...(p.repeat ? { repeat: p.repeat } : {}),
    });
  } catch (error) {
    throw mapWriteFailure(error);
  }
  const id = created?.id !== undefined && created?.id !== null ? String(created.id) : "";
  if (!id) throw writeError("outcome_unknown", "Skylight accepted the write but did not say which meal it created. Read the meals before trying again.");
  const back = await readBackUntil(
    () => listMealSittingsOn(p.date),
    (list) => list.some((s) => s.id === id && matchesCreate(s, p))
  );
  const stored = back.value.find((s) => s.id === id);
  if (!back.ok || !stored) {
    throw writeError(
      "not_confirmed",
      stored
        ? "Skylight created the meal but reading it back shows different fields from those asked. Read it before changing it."
        : "Skylight accepted the write but the meal did not show on reading it back. It may still appear: read the meals before trying again.",
      { eventId: id }
    );
  }
  return stored;
}

// ---------------------------------------------------------------------------------------------
// Update and delete
// ---------------------------------------------------------------------------------------------

interface Found {
  sitting: MealSittingResource;
  kind: MealKind;
}

async function findForWrite(raw: Record<string, unknown>, keys: Set<string>, verb: string): Promise<Found & { date: string }> {
  noUnknown(raw, keys);
  if (typeof raw.id !== "string" || !ID.test(raw.id)) throw writeError("bad_input", "id must be a meal id from meals.sittings().");
  const date = realDate(raw.date, "date");
  if (typeof raw.version !== "string" || raw.version === "") throw writeError("bad_input", "version is required: pass the meal's version from meals.sittings().");
  let list: MealSittingResource[];
  try {
    list = await listMealSittingsOn(date);
  } catch (error) {
    throw mapReadFailure(error);
  }
  const sitting = list.find((s) => s.id === raw.id);
  if (!sitting) throw writeError("not_found", `No meal with that id on ${date}: it may have moved or been deleted. Read the meals again.`);
  if (mealVersion(sitting) !== raw.version) {
    throw writeError("stale", `The meal changed since it was read. Nothing was ${verb}: read it again and show the new version before asking again.`);
  }
  return { sitting, kind: mealKind(sitting), date };
}

/** A read that fails is not a write: sign-in errors pass through, anything else becomes the library's own error. */
function mapReadFailure(error: unknown): unknown {
  const e = error as { name?: string } | null;
  if (e && (e.name === "AuthenticationError" || e.name === "CredentialSaveError")) return error;
  return writeError("outcome_unknown", "Skylight did not answer the read. Nothing was written: try again.");
}

const DETACHED_WORDS = "That occurrence was edited on its own, so it is a standalone meal that Skylight still marks as repeating. It cannot be changed here yet: use the Skylight app.";

interface UpdatePlan {
  found: Found;
  date: string;
  scope: "future" | "all" | null;
  newDate: string;
  seriesStart: string | undefined;
  expect: { title: string; description: string | null; note: string | null; category: string; profileIds: string[] };
  preview: Omit<UpdateMealPreview<never>, "meal">;
}

export async function planUpdateMeal(input: unknown): Promise<UpdatePlan> {
  const raw = obj(input, "update");
  if (raw.scope !== undefined && raw.scope !== "one" && raw.scope !== "future" && raw.scope !== "all") {
    throw writeError("bad_input", 'scope must be "one", "future" or "all".');
  }
  const ch = obj(raw.changes, "changes");
  noUnknown(ch, CHANGE_KEYS, "changes.");
  if (Object.keys(ch).length === 0) throw writeError("bad_input", "changes is empty: say what to change.");
  // Cheap checks first, so a bad request does not cost a read.
  const want: UpdateMealPreview<never>["changes"] = {};
  const fields: { summary?: string; note?: string; description?: string } = {};
  let categoryId: string | undefined;
  let profileIds: string[] | undefined;
  if (ch.title !== undefined) fields.summary = want.title = title(ch.title);
  if (ch.description !== undefined) {
    const d = text(ch.description, "changes.description");
    want.description = d || null;
    if (d) fields.description = d;
  }
  if (ch.note !== undefined) {
    const n = text(ch.note, "changes.note");
    want.note = n || null;
    if (n) fields.note = n;
  }
  if (ch.profileIds !== undefined) profileIds = want.profileIds = ids(ch.profileIds, "changes.profileIds");
  if (ch.category !== undefined) categoryId = typeof ch.category === "string" ? ch.category : "";
  const moveTo = ch.date === undefined ? undefined : realDate(ch.date, "changes.date");
  const warnings = textFindings(fields);

  const found = await findForWrite(raw, UPDATE_KEYS, "changed");
  const { sitting, kind, date } = found;
  if (kind === "detached") throw writeError("unsupported", DETACHED_WORDS);
  const scope = (raw.scope as "one" | "future" | "all" | undefined) ?? null;
  if (kind === "series") {
    if (scope === null) throw writeError("scope_required", 'That is an occurrence of a repeating meal: say scope "future" (this and every later one) or "all" (the whole series).');
    if (scope === "one") {
      throw writeError("unsupported", 'scope "one" is not supported for meals yet: the occurrence would become a standalone meal that could not then be changed here. Use "future" or "all", or the Skylight app.');
    }
    if (moveTo !== undefined && moveTo !== date) throw writeError("unsupported", "Moving an occurrence of a repeating meal to another day is not supported here: use the Skylight app.");
  } else if (scope !== null) {
    throw writeError("scope_not_allowed", "scope applies to an occurrence of a repeating meal only.");
  }
  const r = await refs();
  let category: { id: string; name: string } | undefined;
  if (categoryId !== undefined) {
    category = checkCategory(categoryId, r);
    want.category = category;
  }
  if (profileIds) {
    checkProfiles(profileIds, r);
    want.profiles = profileIds.map((id) => r.profiles.get(id)!);
  }
  let seriesStart: string | undefined;
  if (kind === "series" && scope === "all") {
    let start: string | null;
    try {
      start = await findSeriesStart(sitting.id, date);
    } catch (error) {
      throw mapReadFailure(error);
    }
    if (!start) {
      throw writeError("unsupported", 'Cannot edit the whole series: its start date could not be found, and a guess would delete earlier occurrences. Use scope "future", or the Skylight app.');
    }
    seriesStart = start;
  }
  const newDate = moveTo ?? date;
  if (newDate !== date) want.date = newDate;

  const a = sitting.attributes;
  const expect = {
    title: want.title ?? (typeof a.summary === "string" ? a.summary : ""),
    description: want.description !== undefined ? want.description : typeof a.description === "string" && a.description.trim() ? a.description.trim() : null,
    note: want.note !== undefined ? want.note : typeof a.note === "string" && a.note.trim() ? a.note.trim() : null,
    category: category?.id ?? String(sitting.relationships?.meal_category?.data?.id ?? ""),
    profileIds: profileIds ?? profileIdsOf(sitting),
  };
  const now = {
    title: typeof a.summary === "string" ? a.summary : "",
    description: typeof a.description === "string" && a.description.trim() ? a.description.trim() : null,
    note: typeof a.note === "string" && a.note.trim() ? a.note.trim() : null,
    category: String(sitting.relationships?.meal_category?.data?.id ?? ""),
    profileIds: profileIdsOf(sitting),
  };
  if (
    expect.title === now.title && expect.description === now.description && expect.note === now.note &&
    expect.category === now.category && sameSet(expect.profileIds, now.profileIds) && newDate === date
  ) {
    throw writeError("bad_input", "Those values are already stored: nothing to change.");
  }
  const name = expect.title || "this meal";
  const effect =
    scope === "future" ? `"${name}" on ${date} and every later occurrence (Skylight gives the later ones a new id)`
    : scope === "all" ? `the whole series "${name}", every occurrence past and future`
    : newDate !== date ? `"${name}", moved from ${date} to ${newDate}`
    : `"${name}" on ${date}`;
  return { found: { sitting, kind }, date, scope: scope as "future" | "all" | null, newDate, seriesStart, expect, preview: { action: "update", scope: scope as "future" | "all" | null, changes: want, effect, warnings } };
}

function matchesExpect(s: MealSittingResource, plan: UpdatePlan): boolean {
  const a = s.attributes;
  const e = plan.expect;
  if ((typeof a.summary === "string" ? a.summary : "") !== e.title) return false;
  if (!sameText(a.description, e.description) || !sameText(a.note, e.note)) return false;
  if (String(s.relationships?.meal_category?.data?.id ?? "") !== e.category) return false;
  if (!sameSet(profileIdsOf(s), e.profileIds)) return false;
  if (!(a.instances ?? []).includes(plan.newDate)) return false;
  return plan.found.kind === "series" ? Boolean(a.rrule) : !a.rrule && a.recurring !== true;
}

/** Update, then read back. Resolves with the meal as stored, under its id after the change ("future" gives the rest of the series a new id). */
export async function commitUpdateMeal(input: unknown): Promise<MealSittingResource> {
  const plan = await planUpdateMeal(input);
  const old = plan.found.sitting;
  const w = plan.preview.changes;
  let result: { sittingId: string | null };
  try {
    result = await updateMealSitting({
      existing: old,
      date: plan.date,
      ...(w.date ? { newDate: w.date } : {}),
      ...(w.title !== undefined ? { summary: w.title } : {}),
      ...(w.description !== undefined ? { description: w.description ?? "" } : {}),
      ...(w.note !== undefined ? { note: w.note ?? "" } : {}),
      ...(w.category ? { mealCategoryId: w.category.id } : {}),
      ...(w.profileIds ? { profileIds: w.profileIds } : {}),
      ...(plan.scope ? { scope: plan.scope } : {}),
      ...(plan.seriesStart ? { seriesStart: plan.seriesStart } : {}),
    });
  } catch (error) {
    throw mapWriteFailure(error);
  }
  const pick = (list: MealSittingResource[]): MealSittingResource | undefined =>
    list.find((s) => {
      if (!matchesExpect(s, plan)) return false;
      if (plan.scope === "future") return result.sittingId ? s.id === result.sittingId : s.id !== old.id || true;
      return s.id === old.id;
    });
  const back = await readBackUntil(() => listMealSittingsOn(plan.newDate), (list) => pick(list) !== undefined);
  const stored = pick(back.value);
  if (!back.ok || !stored) {
    throw writeError("not_confirmed", "Skylight accepted the change but reading it back did not show it as asked. Read the meals before trying again.", { eventId: old.id });
  }
  return stored;
}

interface DeletePlan {
  found: Found;
  date: string;
  scope: "one" | "future" | "all" | null;
  effect: string;
}

export async function planDeleteMeal(input: unknown): Promise<DeletePlan> {
  const raw = obj(input, "delete");
  if (raw.scope !== undefined && raw.scope !== "one" && raw.scope !== "future" && raw.scope !== "all") {
    throw writeError("bad_input", 'scope must be "one", "future" or "all".');
  }
  const found = await findForWrite(raw, DELETE_KEYS, "deleted");
  if (found.kind === "detached") throw writeError("unsupported", DETACHED_WORDS);
  const scope = (raw.scope as DeletePlan["scope"] | undefined) ?? null;
  if (found.kind === "series" && scope === null) {
    throw writeError("scope_required", 'That is an occurrence of a repeating meal: say scope "one", "future" (this and every later one) or "all" (the whole series).');
  }
  if (found.kind !== "series" && scope !== null) throw writeError("scope_not_allowed", "scope applies to an occurrence of a repeating meal only.");
  const t = typeof found.sitting.attributes.summary === "string" && found.sitting.attributes.summary ? found.sitting.attributes.summary : "this meal";
  const date = found.date;
  const effect =
    scope === "one" ? `only the occurrence of "${t}" on ${date}`
    : scope === "future" ? `"${t}" on ${date} and every later occurrence`
    : scope === "all" ? `the whole series "${t}", every occurrence past and future`
    : `"${t}" on ${date}`;
  return { found: { sitting: found.sitting, kind: found.kind }, date, scope, effect };
}

/** Delete, then read the date back until the meal is gone from it. */
export async function commitDeleteMeal(input: unknown): Promise<{ deleted: true; id: string; scope: DeletePlan["scope"] }> {
  const plan = await planDeleteMeal(input);
  const id = plan.found.sitting.id;
  try {
    await deleteMealSitting(plan.found.sitting, plan.date, plan.scope ?? "one");
  } catch (error) {
    throw mapWriteFailure(error);
  }
  const back = await readBackUntil(
    () => listMealSittingsOn(plan.date),
    (list) => !list.some((s) => s.id === id)
  );
  if (!back.ok) throw writeError("not_confirmed", "Skylight accepted the delete but the meal still shows on reading it back. Read the meals before trying again.", { eventId: id });
  return { deleted: true, id, scope: plan.scope };
}
