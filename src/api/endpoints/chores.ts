import { getClient } from "../client.js";
import type {
  ChoresResponse,
  ChoreResponse,
  ChoreResource,
  CategoryResource,
  CreateChoreRequest,
  UpdateChoreRequest,
} from "../types.js";

/**
 * A chore is done when Skylight says so. The live API reports `complete` (seen on a
 * real chore and in the web app's completion response); older code and docs said
 * `completed`. Accept both so neither a Skylight change nor an old value flips a done chore to pending.
 */
export function isChoreDone(status: string | null | undefined): boolean {
  return status === "complete" || status === "completed";
}

export interface GetChoresOptions {
  after?: string;
  before?: string;
  includeLate?: boolean;
  /** Shared "Up for Grabs" chores. The web app always asks for them; without this they are never returned. */
  includeUpForGrabs?: boolean;
  filterLinkedToProfile?: boolean;
}

export interface GetChoresResult {
  chores: ChoreResource[];
  categories: CategoryResource[];
}

/**
 * Get chores for a date range
 */
export async function getChores(options: GetChoresOptions = {}): Promise<GetChoresResult> {
  const client = getClient();
  const params: Record<string, string | boolean | undefined> = {
    after: options.after,
    before: options.before,
    include_late: options.includeLate,
    include_up_for_grabs: options.includeUpForGrabs,
  };

  if (options.filterLinkedToProfile) {
    params.filter = "linked_to_profile";
  }

  const response = await client.get<ChoresResponse>(
    "/api/frames/{frameId}/chores",
    params
  );

  return {
    chores: response.data,
    categories: response.included ?? [],
  };
}

export interface CreateChoreOptions {
  summary: string;
  start: string;
  startTime?: string;
  status?: string;
  recurring?: boolean;
  recurrenceSet?: string;
  categoryId?: string;
  rewardPoints?: number;
  emojiIcon?: string;
}

/**
 * Create a new chore
 */
export async function createChore(options: CreateChoreOptions): Promise<ChoreResource> {
  const client = getClient();

  const request: CreateChoreRequest = {
    data: {
      type: "chore",
      attributes: {
        summary: options.summary,
        start: options.start,
        start_time: options.startTime ?? null,
        status: options.status ?? "pending",
        recurring: options.recurring ?? false,
        recurrence_set: options.recurrenceSet ?? null,
        reward_points: options.rewardPoints ?? null,
        emoji_icon: options.emojiIcon ?? null,
      },
    },
  };

  // Add category relationship if provided
  if (options.categoryId) {
    request.data.relationships = {
      category: {
        data: {
          type: "category",
          id: options.categoryId,
        },
      },
    };
  }

  const response = await client.post<ChoreResponse>(
    "/api/frames/{frameId}/chores",
    request
  );

  return response.data;
}

export interface UpdateChoreOptions {
  summary?: string;
  start?: string;
  startTime?: string | null;
  status?: string;
  recurring?: boolean;
  recurrenceSet?: string | null;
  categoryId?: string | null;
  rewardPoints?: number | null;
  emojiIcon?: string | null;
}

/**
 * Update an existing chore
 */
export async function updateChore(
  choreId: string,
  options: UpdateChoreOptions
): Promise<ChoreResource> {
  const client = getClient();

  const request: UpdateChoreRequest = {
    data: {
      type: "chore",
      attributes: {},
    },
  };

  // Map options to attributes
  if (options.summary !== undefined) request.data.attributes.summary = options.summary;
  if (options.start !== undefined) request.data.attributes.start = options.start;
  if (options.startTime !== undefined) request.data.attributes.start_time = options.startTime;
  if (options.status !== undefined) request.data.attributes.status = options.status;
  if (options.recurring !== undefined) request.data.attributes.recurring = options.recurring;
  if (options.recurrenceSet !== undefined) request.data.attributes.recurrence_set = options.recurrenceSet;
  if (options.rewardPoints !== undefined) request.data.attributes.reward_points = options.rewardPoints;
  if (options.emojiIcon !== undefined) request.data.attributes.emoji_icon = options.emojiIcon;

  // Handle category relationship
  if (options.categoryId !== undefined) {
    if (options.categoryId === null) {
      request.data.relationships = { category: { data: null } };
    } else {
      request.data.relationships = {
        category: { data: { type: "category", id: options.categoryId } },
      };
    }
  }

  const response = await client.request<ChoreResponse>(
    `/api/frames/{frameId}/chores/${choreId}`,
    { method: "PUT", body: request }
  );

  return response.data;
}

/**
 * Delete a chore
 */
export async function deleteChore(choreId: string): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/chores/${choreId}`, {
    method: "DELETE",
  });
}

/** A recurring-chore occurrence id: `{series id}-{YYYY-MM-DD}-{HHMM}`. */
const OCCURRENCE_ID = /^(\d+)-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})$/;

export interface ChoreOccurrence {
  seriesId: string;
  instanceDate: string;
  instanceTime: string;
}

/** Split an occurrence id from get_chores into the pieces the completions endpoint wants. Null for any other id (one-off chores, junk). */
export function parseOccurrenceId(id: string): ChoreOccurrence | null {
  const m = OCCURRENCE_ID.exec(id);
  if (!m) return null;
  return { seriesId: m[1], instanceDate: m[2], instanceTime: `${m[3]}:${m[4]}` };
}

export interface CompletionResult {
  summary: string | null;
  status: string | null;
  /** Points balance after the change, when Skylight reports it. */
  pointsBalance: number | null;
  pointsLifetime: number | null;
  currentStreak: number | null;
  longestStreak: number | null;
}

/**
 * Mark one occurrence of a recurring chore (routine) complete or pending.
 * Verified live: the series id goes in the path, the occurrence date/time in the body.
 */
export async function completeChoreOccurrence(
  occurrence: ChoreOccurrence,
  complete: boolean,
  completedOn: string
): Promise<CompletionResult> {
  const client = getClient();
  const body: Record<string, unknown> = complete
    ? { status: "complete", instance_date: occurrence.instanceDate, instance_time: occurrence.instanceTime, completed_on: completedOn }
    : { status: "pending", instance_date: occurrence.instanceDate, instance_time: occurrence.instanceTime };

  const res = await client.request<{
    data?: { attributes?: { summary?: string; status?: string } };
    meta?: { reward_points?: { current_point_balance?: number; lifetime_points_earned?: number } };
    included?: Array<{ type?: string; attributes?: { current_streak?: number; longest_streak?: number } }>;
  }>(`/api/frames/{frameId}/chores/${occurrence.seriesId}/completions`, { method: "PUT", body });

  const tracker = res.included?.find((i) => i.type === "habit_tracker");
  return {
    summary: res.data?.attributes?.summary ?? null,
    status: res.data?.attributes?.status ?? null,
    pointsBalance: res.meta?.reward_points?.current_point_balance ?? null,
    pointsLifetime: res.meta?.reward_points?.lifetime_points_earned ?? null,
    currentStreak: tracker?.attributes?.current_streak ?? null,
    longestStreak: tracker?.attributes?.longest_streak ?? null,
  };
}
