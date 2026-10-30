import { getClient } from "../client.js";
import { addDays, offsetAt, zonedToEpoch } from "../../utils/schedule.js";

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
  const response = await getClient().get<NudgesResponse>("/api/frames/{frameId}/nudges", { after, before });
  return response.data ?? [];
}

export interface CreateNudgeOptions {
  body: string;
  /** Read aloud on the frame when delivered. Off by default. */
  readAloud?: boolean;
  /** Profile (category) id shown as the sender. Omitted when not given. */
  senderCategoryId?: string;
  timeZone: string;
}

interface CreateNudgeResponse {
  data?: NudgeResource | NudgeResource[];
}

/**
 * Send a message to every profile and every device, delivered now.
 * Payload shape is from the web app's "Send Now" call. Targeting specific
 * profiles or devices, and scheduling, are not captured yet and not offered.
 */
export async function createNudge(options: CreateNudgeOptions): Promise<NudgeResource | null> {
  const payload: Record<string, unknown> = {
    body: options.body,
    deliver_at: isoWithOffset(Date.now(), options.timeZone),
    all_profiles: true,
    all_devices: true,
    voice_kind: options.readAloud ? "kirk_voice" : "silent",
  };
  if (options.senderCategoryId) payload.sender_category_id = options.senderCategoryId;
  const response = await getClient().post<CreateNudgeResponse>("/api/frames/{frameId}/nudges", payload);
  const data = response?.data;
  return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
}
