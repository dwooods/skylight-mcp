import { getClient } from "../client.js";
import { addDays, offsetAt, zonedToEpoch } from "../../utils/schedule.js";

/**
 * Messages need the API version the web app sends. Under the repo-wide older
 * version the responses omit all_profiles / all_devices / voice_kind, which
 * made get_messages misreport recipients and the edit guard refuse everything.
 */
export const NUDGES_API_VERSION = "2026-10-15";

/**
 * Skylight calls frame messages "nudges". Shape taken from the web app's
 * list call: GET /api/frames/{frameId}/nudges?after=<ISO>&before=<ISO>.
 */
export interface NudgeResource {
  type: "nudge";
  id: string;
  attributes: {
    body?: string | null;
    /** ISO instant the message is (or was) delivered to the frame. */
    deliver_at?: string;
    rrule?: string | null;
    recurring_until?: string | null;
    voice_kind?: string | null;
    recurring?: boolean;
    all_profiles?: boolean;
    all_devices?: boolean;
    /** Short-lived presigned storage URL. Never surfaced by this server. */
    audio_url?: string | null;
    [key: string]: unknown;
  };
  relationships?: {
    /** Recipient profiles. */
    categories?: { data: Array<{ type: string; id: string }> };
    /** The optional "From" profile. */
    sender_category?: { data: { type: string; id: string } | null };
    devices?: { data: Array<{ type: string; id: string }> };
  };
}

interface NudgesResponse {
  data: NudgeResource[];
}

/** ISO-8601 with the zone's numeric offset, e.g. 2026-10-01T00:00:00.000-07:00. */
export function isoWithOffset(epochMs: number, timeZone: string): string {
  const offsetMin = Math.round(offsetAt(epochMs, timeZone) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const local = new Date(epochMs + offsetMin * 60_000).toISOString().slice(0, 23);
  return `${local}${sign}${hh}:${mm}`;
}

/** Messages delivered between two local dates, inclusive. */
export async function getNudges(startDate: string, endDate: string, timeZone: string): Promise<NudgeResource[]> {
  const after = isoWithOffset(zonedToEpoch(startDate, "00:00", timeZone), timeZone);
  const before = isoWithOffset(zonedToEpoch(addDays(endDate, 1), "00:00", timeZone) - 1, timeZone);
  const response = await getClient().request<NudgesResponse>("/api/frames/{frameId}/nudges", {
    method: "GET",
    params: { after, before },
    apiVersion: NUDGES_API_VERSION,
  });
  return response.data ?? [];
}

export interface CreateNudgeOptions {
  body: string;
  /** Read aloud on the frame when delivered. Off by default. */
  readAloud?: boolean;
  /** Profile (category) id shown as the sender. Omitted when not given. */
  senderCategoryId?: string;
  /** Send only to these profile (category) ids. Omitted means everyone. */
  recipientCategoryIds?: string[];
  timeZone: string;
}

interface CreateNudgeResponse {
  data?: NudgeResource | NudgeResource[];
}

/**
 * Send a message to every profile and every device, delivered now.
 * Payload shape is from the web app's "Send Now" call. Targeting specific
 * profiles is inferred from how Skylight stores a message sent to one profile
 * (all_profiles false plus that profile in categories) and from another open
 * source client that sends category_ids; the POST itself has not been captured.
 * Targeting devices and scheduling are not offered.
 */
export async function createNudge(options: CreateNudgeOptions): Promise<NudgeResource | null> {
  const payload: Record<string, unknown> = {
    body: options.body,
    deliver_at: isoWithOffset(Date.now(), options.timeZone),
    all_profiles: !options.recipientCategoryIds?.length,
    all_devices: true,
    voice_kind: options.readAloud ? "kirk_voice" : "silent",
  };
  if (options.recipientCategoryIds?.length) payload.category_ids = options.recipientCategoryIds;
  if (options.senderCategoryId) payload.sender_category_id = options.senderCategoryId;
  const response = await getClient().request<CreateNudgeResponse>("/api/frames/{frameId}/nudges", {
    method: "POST",
    body: payload,
    apiVersion: NUDGES_API_VERSION,
  });
  const data = response?.data;
  return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
}

/** Message ids are numeric. Validate before one ever reaches a URL path. */
export function assertNudgeId(id: string): string {
  if (!/^\d{1,12}$/.test(id)) throw new Error("Message ID must be numeric (see get_messages).");
  return id;
}

/** Find one message by id within +/- 31 days of today. */
export async function findNudge(id: string, timeZone: string): Promise<NudgeResource | null> {
  const today = new Date();
  const day = (offset: number): string => {
    const d = new Date(today.getTime() + offset * 86_400_000);
    return d.toLocaleDateString("en-CA", { timeZone });
  };
  const nudges = await getNudges(day(-31), day(31), timeZone);
  return nudges.find((n) => n.id === id) ?? null;
}

export interface UpdateNudgeOptions {
  existing: NudgeResource;
  body: string;
  /** Replace the sender profile id. Keeps the current sender when undefined. */
  senderCategoryId?: string;
  timeZone: string;
}

/**
 * Edit a message the way the web app does: PATCH with the whole form.
 * Only messages sent to everyone on all devices and not repeating are
 * supported, because those are the only shapes captured.
 */
export async function updateNudge(options: UpdateNudgeOptions): Promise<void> {
  const { existing } = options;
  const a = existing.attributes;
  if (a.all_profiles !== true || a.all_devices !== true || a.recurring === true || a.rrule) {
    throw new Error("Only messages sent to everyone on all devices, and not repeating, can be edited here. Edit this one in the Skylight app.");
  }
  const deliverAt = Date.parse(a.deliver_at ?? "");
  if (Number.isNaN(deliverAt)) throw new Error("Message has no delivery time; edit it in the Skylight app.");
  const sender = options.senderCategoryId ?? existing.relationships?.sender_category?.data?.id;
  const payload: Record<string, unknown> = {
    body: options.body,
    deliver_at: isoWithOffset(deliverAt, options.timeZone),
    all_profiles: true,
    all_devices: true,
    voice_kind: a.voice_kind ?? "silent",
  };
  if (sender) payload.sender_category_id = sender;
  await getClient().request(`/api/frames/{frameId}/nudges/${assertNudgeId(existing.id)}`, {
    method: "PATCH",
    body: payload,
    apiVersion: NUDGES_API_VERSION,
  });
}

/**
 * Delete a message: DELETE /nudges/{id}. The Skylight web app offers no delete
 * button, so this call is taken from two other open-source clients and has not
 * been confirmed against this account's API version until a live run says so.
 * Returns the HTTP outcome only; callers must read back to confirm removal.
 */
export async function deleteNudge(existing: NudgeResource): Promise<void> {
  await getClient().request(`/api/frames/{frameId}/nudges/${assertNudgeId(existing.id)}`, {
    method: "DELETE",
    apiVersion: NUDGES_API_VERSION,
  });
}
