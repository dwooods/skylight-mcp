/**
 * Library entry point (experimental). The only module an importer may load:
 * package.json `exports` lists this file and nothing else.
 *
 *   import { createSkylight } from "@davidwoods/skylight-mcp";
 *
 * Guarantees, each covered by tests/library-*.test.ts from the importer's side:
 * - The API host is pinned in code. There is no host, base URL or fetch option; an
 *   unknown option is refused, not ignored.
 * - Returned objects are plain JSON-safe DTOs. They never carry emails, event uids,
 *   calendar or account ids, or a subscription feed address.
 * - No function takes a URL or a feed address (so the feed-address helper is not exported either).
 * - Importing this module starts nothing and reads nothing from process.argv.
 *
 * Reads, plus calendar event writes (experimental): create, update and delete, each as a preview
 * and a commit with identical arguments that share one check (src/lib-writes.ts). Other writes,
 * messages, source-calendar management and login are deliberately not exported.
 *
 * Honest limit: an importer holds a live bearer token and can do whatever the token
 * allows. These guards stop accidents and token leakage, not a malicious importer.
 */

import type { Config } from "./config.js";
import { SkylightClient } from "./api/client.js";
import type { CredentialStore } from "./api/credential-types.js";
import { runWithContext } from "./context.js";
import { getCalendarEvents, getSourceCalendars } from "./api/endpoints/calendar.js";
import { getCategories } from "./api/endpoints/categories.js";
import { getChores } from "./api/endpoints/chores.js";
import { getListWithItems, getLists } from "./api/endpoints/lists.js";
import { getMealCategories, getMealSittingsWithProfiles, getRecipes, mealCategoryName, mealKind, type MealSittingResource } from "./api/endpoints/meals.js";
import { mealVersion } from "./lib-meals.js";
import {
  commitCreateMeal,
  commitDeleteMeal,
  commitUpdateMeal,
  planCreateMeal,
  planDeleteMeal,
  planUpdateMeal,
  type CreateMealInput,
  type CreateMealPreview,
  type DeleteMealInput,
  type DeleteMealPreview,
  type UpdateMealInput,
  type UpdateMealPreview,
} from "./lib-meal-writes.js";
import { isChoreDone, parseOccurrenceId } from "./api/endpoints/chores.js";
import { addDays } from "./utils/schedule.js";
import { redactFeedUrl } from "./utils/redact.js";
import { parseRrule, type MealRepeat, type OtherRepeat } from "./utils/meal-repeat.js";
import type { CalendarEventResource, CategoryResource, ChoreResource, SourceCalendarResource } from "./api/types.js";
import {
  afterWrite,
  asRead,
  commitCreate,
  commitDelete,
  commitUpdate,
  eventVersion,
  planCreate,
  planDelete,
  planUpdate,
  sourceIsDefault,
  sourceLabels,
  sourceWritable,
  writeError,
  type CreateEventInput,
  type CreatePreview,
  type DeleteEventInput,
  type DeletePreview,
  type UpdateEventInput,
  type UpdatePreview,
} from "./lib-writes.js";

export type {
  CreateEventInput,
  CreatePreview,
  DeleteEventInput,
  DeletePreview,
  EventRef,
  SkylightWriteError,
  UpdateEventInput,
  UpdatePreview,
  WriteErrorCode,
} from "./lib-writes.js";
export type {
  CreateMealInput,
  CreateMealPreview,
  DeleteMealInput,
  DeleteMealPreview,
  MealOccurrences,
  MealRef,
  MealRepeat,
  MealRepeatInput,
  OtherRepeat,
  RepeatNotice,
  UpdateMealInput,
  UpdateMealPreview,
  Weekday,
} from "./lib-meal-writes.js";
export type { SeriesInput } from "./utils/series.js";

export type { CredentialStore };

/** Where the sign-in comes from: a store that refreshes it, or a fixed token that does not. */
export type SkylightCredential = CredentialStore | { token: string };

export interface CreateSkylightOptions {
  /** Household id: digits, from the Skylight web app's URLs. */
  frameId: string;
  /** IANA zone, for example "America/Los_Angeles". */
  timezone: string;
  credential: SkylightCredential;
  /**
   * How a synced calendar's name leaves `calendar.sources()` and the create preview's `calendar.label`.
   * "masked" (the default) replaces an email-shaped name with "Google calendar" or "Calendar", so no address
   * escapes. "as-is" returns the name exactly as Skylight has it, an address included: the importer then owns
   * where it is shown. It never adds the calendar's source id or account, and it changes nothing else (event
   * and profile labels stay masked).
   */
  labels?: "masked" | "as-is";
}

/**
 * An event. `id` is opaque: a repeating event's occurrence ids embed the start time and
 * CHANGE after a time edit, so never store or compare ids across edits. `seriesId` is the
 * series number for occurrences of a repeating event, else null.
 */
export interface EventDto {
  id: string;
  title: string;
  /** ISO 8601 with offset, or a local-midnight stamp for all-day events. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  location: string | null;
  /** Profile names, as `profiles.list()` labels them. */
  profiles: string[];
  /** Label names, as `labels.list()` labels them. Two labels can share a name: use `labelIds` to tell them apart. */
  labels: string[];
  /** Ids of `profiles`, same order. Match these against `profiles.list()` ids. */
  profileIds: string[];
  /** Ids of `labels`, same order. Match these against `labels.list()` ids. */
  labelIds: string[];
  recurring: boolean;
  seriesId: string | null;
  /** True for an occurrence that was edited on its own: it is its own event now, deleted without a scope. */
  detached: boolean;
  editable: boolean;
  source: "skylight" | "google" | "feed" | "other";
  /** Fingerprint of the fields shown here (and notes and the rule). Pass it back with `id` and the date to update or delete; a changed event is refused as "stale". */
  version: string;
}

export interface SourceDto {
  id: string;
  /** As Skylight has it. An email-shaped label is replaced unless `createSkylight` was given `labels: "as-is"`. Two calendars can share a placeholder: tell them apart by `id`. */
  label: string;
  kind: "google" | "feed" | "other";
  role: string | null;
  editable: boolean;
  /** Scheme and host of a subscription feed only; null otherwise. */
  host: string | null;
  /** True when `calendar.create` can write to it: a Google calendar this account can edit. */
  writable: boolean;
  /**
   * True when the Skylight app preselects this calendar for new events. At most one is expected, and none
   * means the household's default is "No calendar" (Skylight's own). It can be set on a calendar that is not
   * `writable`: check both before offering it.
   */
  skylightDefault: boolean;
}

export interface ProfileDto {
  id: string;
  label: string;
  color: string | null;
}

/**
 * A label: a category that is not a profile (a feed, a holiday calendar, a team). Same shape as
 * ProfileDto. `color` is the string Skylight stores, or null. Seen live: six-digit hex with a "#",
 * in either case ("#2178AF", "#fdb305"), including colours outside the app's palette. Treat it as untrusted text and validate before using it as a style.
 * `label` is an email-shaped name replaced by "Calendar", exactly as in `EventDto.labels`.
 */
export interface LabelDto {
  id: string;
  label: string;
  color: string | null;
}

export interface ChoreDto {
  id: string;
  title: string;
  date: string | null;
  time: string | null;
  status: string;
  done: boolean;
  profile: string | null;
  upForGrabs: boolean;
  routine: boolean;
  recurring: boolean;
  points: number | null;
}

export interface MealSittingDto {
  id: string;
  dates: string[];
  title: string | null;
  category: string | null;
  recipeId: string | null;
  recurring: boolean;
  /** The "Instructions or ingredients" text, exactly as stored (line breaks kept). Often a recipe link plus steps. Null when empty. */
  description: string | null;
  /** The meal's note, exactly as stored (line breaks kept). Null when empty. */
  note: string | null;
  /** Names of the profiles the meal is for, as `profiles.list()` labels them. Empty when unassigned. */
  profiles: string[];
  /** Ids of `profiles`, same order. */
  profileIds: string[];
  /** True for an occurrence that was edited on its own: its own sitting now, still marked as repeating, with no link back to the series. */
  detached: boolean;
  /**
   * How the meal repeats: null for a one-off or a detached day; the rule's parts for a series
   * (`until` inclusive, null when open-ended); `{ every: "other" }` for a stored rule using parts
   * the library does not describe (a count, several months, ...).
   */
  repeat: MealRepeat | OtherRepeat | null;
  /** Fingerprint of the fields shown here (and the rule). Changes when the title, category, recipe, text, people or rule change; not when other days of a series change. */
  version: string;
}

export interface RecipeDto {
  id: string;
  title: string | null;
}

export interface MealCategoryDto {
  id: string;
  name: string;
}

export interface ListDto {
  id: string;
  label: string;
  kind: string;
  color: string | null;
}

export interface ListItemDto {
  id: string;
  label: string;
  done: boolean;
  section: string | null;
}

export interface Skylight {
  calendar: {
    /** Events from `from` to `to`, both YYYY-MM-DD, both days included. */
    events(range: { from: string; to: string }): Promise<EventDto[]>;
    sources(): Promise<SourceDto[]>;
    /** Check a new event and return exactly what `create` would write. Changes nothing. */
    previewCreate(input: CreateEventInput): Promise<CreatePreview>;
    /**
     * Re-run the same check against fresh reads, write, then read back. Resolves with the event as
     * Skylight stored it, only when the read-back shows every field as asked. Throws an Error with
     * `name` "SkylightWriteError" and a `code` otherwise (see CreateEventInput and README).
     */
    create(input: CreateEventInput): Promise<EventDto>;
    /** Check a change to one event and return exactly what `update` would write. Changes nothing. */
    previewUpdate(input: UpdateEventInput): Promise<UpdatePreview<EventDto>>;
    /** Re-run the same check (including the version), write, read back. Resolves with the event under its id after the change. */
    update(input: UpdateEventInput): Promise<EventDto>;
    /** Check a delete and show the event and what it reaches. Changes nothing. */
    previewDelete(input: DeleteEventInput): Promise<DeletePreview<EventDto>>;
    /** Re-run the same check (including the version), delete, read back until it is gone. */
    delete(input: DeleteEventInput): Promise<{ deleted: true; id: string; scope: "one" | "future" | "all" | null }>;
  };
  profiles: { list(): Promise<ProfileDto[]> };
  /** Every label (category not linked to a profile), in Skylight's order, including labels no event uses. */
  labels: { list(): Promise<LabelDto[]> };
  /**
   * Chores for one day (`date`) or a range (`from` and `to`, both included, at most 31 days).
   * Pass one or the other, not both. A repeating chore appears once per day it falls on; `date`
   * on each item is that day.
   */
  chores: { list(options: { date: string; profile?: string } | { from: string; to: string; profile?: string }): Promise<ChoreDto[]> };
  meals: {
    sittings(range: { from: string; to: string }): Promise<MealSittingDto[]>;
    recipes(): Promise<RecipeDto[]>;
    categories(): Promise<MealCategoryDto[]>;
    /** Check a new meal and return exactly what `create` would write. Changes nothing. */
    previewCreate(input: CreateMealInput): Promise<CreateMealPreview>;
    /** Re-run the same check, write, read back. Resolves with the meal as stored; throws SkylightWriteError otherwise. Needs Skylight Plus. */
    create(input: CreateMealInput): Promise<MealSittingDto>;
    /** Check a change to one meal and show what it reaches. Changes nothing. */
    previewUpdate(input: UpdateMealInput): Promise<UpdateMealPreview<MealSittingDto>>;
    /** Re-run the same check (including the version), write, read back. Resolves with the meal under its id after the change (scope "future" gives the later days a new id). */
    update(input: UpdateMealInput): Promise<MealSittingDto>;
    /** Check a delete and show what it reaches. Changes nothing. */
    previewDelete(input: DeleteMealInput): Promise<DeleteMealPreview<MealSittingDto>>;
    /** Re-run the same check (including the version), delete, read back until it is gone from that day. */
    delete(input: DeleteMealInput): Promise<{ deleted: true; id: string; scope: "one" | "future" | "all" | null }>;
  };
  lists: {
    list(): Promise<ListDto[]>;
    items(listId: string): Promise<ListItemDto[]>;
  };
}

// ---------------------------------------------------------------------------
// Validation: refuse, never ignore.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/;
const OPTION_KEYS = new Set(["frameId", "timezone", "credential", "labels"]);

function assertDate(value: unknown, name: string): string {
  if (typeof value !== "string" || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${name} must be a date, YYYY-MM-DD.`);
  }
  return value;
}

function assertRange(range: { from: string; to: string }): { from: string; to: string } {
  const from = assertDate(range?.from, "from");
  const to = assertDate(range?.to, "to");
  if (to < from) throw new Error("to is before from.");
  return { from, to };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function isStore(value: unknown): value is CredentialStore {
  const v = value as Record<string, unknown> | null;
  return !!v && typeof v === "object" && typeof v.read === "function" && typeof v.write === "function" && typeof v.delete === "function";
}

function validateOptions(options: CreateSkylightOptions): { config: Config; store: CredentialStore | null; labelsAsIs: boolean } {
  if (!options || typeof options !== "object") throw new Error("createSkylight needs an options object.");
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw new Error(`Unknown option "${key}". The API host is fixed and cannot be configured.`);
  }
  const { frameId, timezone, credential, labels } = options;
  if (labels !== undefined && labels !== "masked" && labels !== "as-is") throw new Error('labels must be "masked" or "as-is".');
  const labelsAsIs = labels === "as-is";
  if (typeof frameId !== "string" || !/^\d+$/.test(frameId)) throw new Error("frameId must be the household's numeric id.");
  if (typeof timezone !== "string") throw new Error("timezone must be an IANA zone name.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error("timezone must be an IANA zone name.");
  }
  if (isStore(credential)) {
    return { config: { frameId, timezone, authType: "bearer" }, store: credential, labelsAsIs };
  }
  const keys = credential && typeof credential === "object" ? Object.keys(credential) : [];
  if (keys.length === 1 && keys[0] === "token" && typeof (credential as { token: unknown }).token === "string" && (credential as { token: string }).token) {
    return { config: { frameId, timezone, authType: "bearer", token: (credential as { token: string }).token }, store: null, labelsAsIs };
  }
  throw new Error("credential must be a credential store or { token }.");
}

// ---------------------------------------------------------------------------
// Projection: raw JSON:API in, DTOs out. Every field is named here; nothing is spread.

function categoryIds(event: CalendarEventResource): string[] {
  const ids = new Set<string>();
  for (const ref of event.relationships?.categories?.data ?? []) if (ref?.id) ids.add(String(ref.id));
  const single = event.relationships?.category?.data?.id;
  if (single) ids.add(String(single));
  const fromAttrs = event.attributes.category_ids;
  if (Array.isArray(fromAttrs)) for (const id of fromAttrs) ids.add(String(id));
  return [...ids];
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function toMeal(s: MealSittingResource, names: Map<string, string>, profileLabels: Map<string, string>, keep: (date: string) => boolean): MealSittingDto {
  const a = s.attributes;
  const dates = a.instances?.length ? a.instances : a.date ? [a.date] : [];
  const cid = s.relationships?.meal_category?.data?.id;
  const rid = s.relationships?.meal_recipe?.data?.id;
  const profileIds = (s.relationships?.profiles?.data ?? []).map((p) => String(p.id));
  return {
    id: String(s.id),
    dates: dates.filter((d) => DATE.test(d) && keep(d)),
    title: str(a.summary),
    category: cid ? (names.get(String(cid)) ?? null) : null,
    recipeId: rid ? String(rid) : null,
    recurring: a.recurring === true || Boolean(a.rrule),
    description: str(a.description),
    note: str(a.note),
    // An email-shaped label is replaced, as for events; an id with no label reads "Someone".
    profiles: profileIds.map((id) => {
      const label = profileLabels.get(id);
      return label === undefined ? "Someone" : EMAIL.test(label) ? "Calendar" : label;
    }),
    profileIds,
    detached: mealKind(s) === "detached",
    repeat: mealKind(s) === "series" ? parseRrule(typeof a.rrule === "string" ? a.rrule : null) : null,
    version: mealVersion(s),
  };
}

/** A meal from a write, with category and people named. Days are the ones the sitting reports. */
async function withMealNames(s: MealSittingResource): Promise<MealSittingDto> {
  const [categories, all] = await Promise.all([getMealCategories(), getCategories()]);
  const labels = new Map<string, string>();
  for (const c of all) {
    const label = (c.attributes as { label?: unknown }).label;
    if (c.attributes.linked_to_profile === true && typeof label === "string" && label.trim()) labels.set(String(c.id), label.trim());
  }
  return toMeal(s, new Map(categories.map((c) => [String(c.id), mealCategoryName(c)])), labels, () => true);
}

/** A category's name as it leaves the library: an email-shaped name is replaced, so no address escapes. */
function categoryName(c: CategoryResource | undefined): string | null {
  const label = str(c?.attributes.label);
  return label !== null && EMAIL.test(label) ? "Calendar" : label;
}

function toEvent(event: CalendarEventResource, categories: Map<string, CategoryResource>): EventDto {
  const a = event.attributes;
  const profiles: string[] = [];
  const labels: string[] = [];
  const profileIds: string[] = [];
  const labelIds: string[] = [];
  for (const id of categoryIds(event)) {
    const c = categories.get(id);
    const label = categoryName(c);
    if (!c || !label) continue;
    if (c.attributes.linked_to_profile === true) {
      profiles.push(label);
      profileIds.push(String(c.id));
    } else {
      labels.push(label);
      labelIds.push(String(c.id));
    }
  }
  const id = String(event.id);
  const composite = /^(\d+)-\d+$/.exec(id);
  const source = a.source === "skylight" ? "skylight" : a.source === "google" ? "google" : a.source === "ics_link" ? "feed" : "other";
  return {
    id,
    title: str(a.summary) ?? "",
    start: str(a.starts_at),
    end: str(a.ends_at),
    allDay: a.all_day === true,
    location: str(a.location),
    profiles,
    labels,
    profileIds,
    labelIds,
    recurring: a.recurring === true || a.recurring_config === true,
    seriesId: composite ? composite[1]! : null,
    detached: a.master_event_id != null && a.master_event_id !== "",
    editable: a.editable !== false,
    source,
    version: eventVersion(event, categoryIds),
  };
}

function toSource(cal: SourceCalendarResource, labels: Map<string, string>): SourceDto {
  const a = cal.attributes;
  const kind = a.kind === "gmail" ? "google" : a.kind === "webcal" ? "feed" : "other";
  const label = labels.get(String(cal.id)) ?? "Calendar";
  const sourceId = str(a.source_id);
  const hostMatch = kind === "feed" && sourceId ? /^([a-z]+:\/\/[^/]+)/i.exec(redactFeedUrl(sourceId)) : null;
  return {
    id: String(cal.id),
    label,
    kind,
    role: str(a.role),
    editable: a.editable === true,
    host: hostMatch ? hostMatch[1]! : null,
    writable: sourceWritable(cal),
    skylightDefault: sourceIsDefault(cal),
  };
}

function toChore(chore: ChoreResource, names: Map<string, string>): ChoreDto {
  const a = chore.attributes;
  const cid = chore.relationships?.category?.data?.id;
  return {
    id: String(chore.id),
    title: str(a.summary) ?? "",
    // An occurrence of a repeating chore carries its own day in its id ({series}-{YYYY-MM-DD}-{HHMM},
    // verified live for completions); `start` may be the series' first day.
    date: parseOccurrenceId(String(chore.id))?.instanceDate ?? str(a.start),
    time: str(a.start_time),
    status: str(a.status) ?? "",
    done: isChoreDone(a.status),
    profile: cid ? (names.get(String(cid)) ?? null) : null,
    upForGrabs: a.up_for_grabs === true,
    routine: a.routine === true,
    recurring: a.recurring === true,
    points: typeof a.reward_points === "number" ? a.reward_points : null,
  };
}

// ---------------------------------------------------------------------------

export function createSkylight(options: CreateSkylightOptions): Skylight {
  const { config, store, labelsAsIs } = validateOptions(options);
  // Quiet: no per-request trace lines in the importer's logs. Errors and warnings still print.
  const client = new SkylightClient(config, store, { quiet: true });
  const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext({ client, config }, fn);
  // A preview only reads: any failure that is not the library's own is `read_failed` (nothing written).
  const runRead = <T>(fn: () => Promise<T>): Promise<T> => run(() => asRead(fn));
  // A commit maps every failure itself. Anything that still escapes is reported as an unknown
  // outcome (read before retrying), never as Skylight's raw error.
  const runCommit = <T>(fn: () => Promise<T>): Promise<T> =>
    run(async () => {
      try {
        return await fn();
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        if (name === "SkylightWriteError" || name === "AuthenticationError" || name === "CredentialSaveError") throw error;
        throw writeError("outcome_unknown", "An unexpected error came up during the write. It may or may not have been written: read before trying again.");
      }
    });
  const eventResult = (stored: CalendarEventResource) =>
    afterWrite(String(stored.id), "the calendar", async () => toEvent(stored, new Map((await getCategories()).map((c) => [String(c.id), c]))));

  return {
    calendar: {
      events: (range) =>
        run(async () => {
          const { from, to } = assertRange(range);
          const [events, categories] = await Promise.all([
            getCalendarEvents({ dateMin: from, dateMax: to, timezone: config.timezone }),
            getCategories(),
          ]);
          const byId = new Map(categories.map((c) => [String(c.id), c]));
          return events.map((e) => toEvent(e, byId));
        }),
      sources: () =>
        run(async () => {
          const cals = await getSourceCalendars();
          const labels = sourceLabels(cals, labelsAsIs);
          return cals.map((c) => toSource(c, labels));
        }),
      previewCreate: (input) => runRead(async () => (await planCreate(input, config.timezone, labelsAsIs)).preview),
      create: (input) => runCommit(async () => eventResult(await commitCreate(input, config.timezone, categoryIds, labelsAsIs))),
      previewUpdate: (input) =>
        runRead(async () => {
          const plan = await planUpdate(input, config.timezone, categoryIds);
          const byId = new Map((await getCategories()).map((c) => [String(c.id), c]));
          return {
            action: "update" as const,
            event: toEvent(plan.found.event, byId),
            scope: plan.scope,
            changes: plan.changes,
            effect: plan.effect,
            google: plan.found.google,
            warnings: plan.found.google ? ["This event is on a Google calendar: the change reaches everyone who shares it."] : [],
          };
        }),
      update: (input) => runCommit(async () => eventResult(await commitUpdate(input, config.timezone, categoryIds))),
      previewDelete: (input) =>
        runRead(async () => {
          const plan = await planDelete(input, config.timezone, categoryIds);
          const byId = new Map((await getCategories()).map((c) => [String(c.id), c]));
          return { action: "delete" as const, event: toEvent(plan.found.event, byId), scope: plan.scope, effect: plan.effect, google: plan.found.google };
        }),
      delete: (input) => runCommit(() => commitDelete(input, config.timezone, categoryIds)),
    },
    profiles: {
      list: () =>
        run(async () =>
          (await getCategories())
            .filter((c) => c.attributes.linked_to_profile === true && categoryName(c))
            .map((c) => ({ id: String(c.id), label: categoryName(c) as string, color: str(c.attributes.color) }))
        ),
    },
    labels: {
      list: () =>
        run(async () =>
          (await getCategories())
            .filter((c) => c.attributes.linked_to_profile !== true && categoryName(c))
            .map((c) => ({ id: String(c.id), label: categoryName(c) as string, color: str(c.attributes.color) }))
        ),
    },
    chores: {
      list: (opts) =>
        run(async () => {
          const o = (opts ?? {}) as { date?: unknown; from?: unknown; to?: unknown; profile?: unknown };
          for (const key of Object.keys(o)) {
            if (!["date", "from", "to", "profile"].includes(key)) throw new Error(`Unknown option "${key}".`);
          }
          let from: string;
          let to: string;
          if (o.date !== undefined) {
            if (o.from !== undefined || o.to !== undefined) throw new Error("Pass date, or from and to, not both.");
            from = to = assertDate(o.date, "date");
          } else {
            ({ from, to } = assertRange({ from: o.from as string, to: o.to as string }));
            if (daysBetween(from, to) > 30) throw new Error("A chores range is at most 31 days.");
          }
          // `before` is inclusive: the one-day call has always sent after = before = the day.
          const result = await getChores({ after: from, before: to, includeLate: false, includeUpForGrabs: true });
          const names = new Map(result.categories.map((c) => [String(c.id), c.attributes.label ?? ""]));
          let chores = result.chores.map((c) => toChore(c, names));
          if (o.profile !== undefined) {
            if (typeof o.profile !== "string") throw new Error("profile must be a profile name.");
            const wanted = o.profile.trim().toLowerCase();
            chores = chores.filter((c) => c.profile?.toLowerCase() === wanted);
          }
          return chores;
        }),
    },
    meals: {
      sittings: (range) =>
        run(async () => {
          const { from, to } = assertRange(range);
          const [{ sittings, profileLabels }, categories] = await Promise.all([
            getMealSittingsWithProfiles({ dateMin: from, dateMax: addDays(to, 1) }),
            getMealCategories(),
          ]);
          const names = new Map(categories.map((c) => [String(c.id), mealCategoryName(c)]));
          return sittings.map((s) => toMeal(s, names, profileLabels, (d) => d >= from && d <= to));
        }),
      previewCreate: (input) => runRead(async () => (await planCreateMeal(input)).preview),
      create: (input) =>
        runCommit(async () => {
          const stored = await commitCreateMeal(input);
          return afterWrite(stored.id, "the meals", () => withMealNames(stored));
        }),
      previewUpdate: (input) =>
        runRead(async () => {
          const plan = await planUpdateMeal(input);
          return { ...plan.preview, meal: await withMealNames(plan.found.sitting) };
        }),
      update: (input) =>
        runCommit(async () => {
          const stored = await commitUpdateMeal(input);
          return afterWrite(stored.id, "the meals", () => withMealNames(stored));
        }),
      previewDelete: (input) =>
        runRead(async () => {
          const plan = await planDeleteMeal(input);
          return { action: "delete" as const, meal: await withMealNames(plan.found.sitting), scope: plan.scope, effect: plan.effect };
        }),
      delete: (input) => runCommit(() => commitDeleteMeal(input)),
      recipes: () =>
        run(async () => (await getRecipes()).map((r) => ({ id: String(r.id), title: str(r.attributes.summary) }))),
      categories: () =>
        run(async () => (await getMealCategories()).map((c) => ({ id: String(c.id), name: mealCategoryName(c) }))),
    },
    lists: {
      list: () =>
        run(async () =>
          (await getLists()).map((l) => ({
            id: String(l.id),
            label: str(l.attributes.label) ?? "",
            kind: str(l.attributes.kind) ?? "",
            color: str(l.attributes.color),
          }))
        ),
      items: (listId) =>
        run(async () => {
          if (typeof listId !== "string" || !/^\d+$/.test(listId)) throw new Error("listId must be a numeric list id.");
          const { items } = await getListWithItems(listId);
          return items.map((i) => ({
            id: String(i.id),
            label: str(i.attributes.label) ?? "",
            done: i.attributes.status === "completed",
            section: str(i.attributes.section),
          }));
        }),
    },
  };
}
