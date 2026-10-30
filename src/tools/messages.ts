import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { assertNudgeId, createNudge, findNudge, getNudges, updateNudge, type NudgeResource } from "../api/endpoints/messages.js";
import { getCategories, findCategoryByName } from "../api/endpoints/categories.js";
import { getConfig } from "../config.js";
import { parseDate, getDateOffset } from "../utils/dates.js";
import { dateInZone, formatDay, formatTime } from "../utils/schedule.js";
import { formatErrorForMcp } from "../utils/errors.js";

export function registerMessageTools(server: McpServer): void {
  server.tool(
    "get_messages",
    `Get messages (Skylight calls them "nudges") shown on the family frame.

Use this when:
- Checking what has already been posted to the frame
- Avoiding a duplicate before sending a reminder

Returns: Messages grouped by day with time, text, recipients and sender.
Defaults to the last 7 days through the next 7 days. Max 31 days.`,
    {
      date: z.string().optional().describe("Start date (YYYY-MM-DD or 'today'). Default: 7 days ago."),
      dateEnd: z.string().optional().describe("End date, inclusive. Default: 7 days ahead."),
    },
    async ({ date, dateEnd }) => {
      try {
        const { timezone } = getConfig();
        const start = date ? parseDate(date, timezone) : getDateOffset(-7, timezone);
        const end = dateEnd ? parseDate(dateEnd, timezone) : getDateOffset(7, timezone);
        if (end < start) throw new Error("dateEnd is before date.");
        const days = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
        if (days > 31) throw new Error("Range is limited to 31 days.");

        const [nudges, categories] = await Promise.all([
          getNudges(start, end, timezone),
          getCategories().catch(() => []),
        ]);
        const names = new Map(categories.map((c) => [c.id, c.attributes.label ?? `profile ${c.id}`]));

        if (nudges.length === 0) {
          return { content: [{ type: "text" as const, text: `No messages from ${start} to ${end}.` }] };
        }

        const sorted = [...nudges].sort((a, b) => Date.parse(a.attributes.deliver_at ?? "") - Date.parse(b.attributes.deliver_at ?? ""));
        const byDay = new Map<string, string[]>();
        for (const n of sorted) {
          const at = Date.parse(n.attributes.deliver_at ?? "");
          if (Number.isNaN(at)) continue;
          const day = dateInZone(at, timezone);
          const line = `- ${formatTime(at, timezone)}: "${n.attributes.body ?? ""}"${describeRoute(n, names)} [message ID: ${n.id}]`;
          byDay.set(day, [...(byDay.get(day) ?? []), line]);
        }
        const text = [...byDay.entries()].map(([d, lines]) => `${formatDay(d)}\n${lines.join("\n")}`).join("\n\n");
        return { content: [{ type: "text" as const, text: `Messages ${start} to ${end}:\n\n${text}` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatErrorForMcp(error) }], isError: true };
      }
    }
  );
  server.tool(
    "send_message",
    `Post a message to the family frame (shown to everyone, on all devices, now).

PERMANENT: Skylight has no way to delete a message, and it appears on the family
frame for the whole household immediately.

Two-step by design. Called without confirm it only previews and posts nothing.
Show the user the exact text and get a clear yes, then call again with confirm: true.
Never pass confirm: true on the first call, and never invent message text the user
did not ask for. Read aloud is OFF by default; enable it only if the user asked.

Check get_messages first to avoid posting a duplicate.`,
    {
      body: z.string().min(1).max(300).describe("Message text, up to 300 characters."),
      readAloud: z.boolean().optional().describe("Speak the message on the frame when delivered. Default false."),
      from: z.string().optional().describe("Optional sender profile name, e.g. a family member. Omit for no sender."),
      confirm: z.boolean().optional().describe("Must be true to actually post. Default false: preview only."),
    },
    async ({ body, readAloud, from, confirm }) => {
      try {
        const text = body.trim();
        if (!text) throw new Error("Message is empty.");
        let senderCategoryId: string | undefined;
        if (from) {
          const match = await findCategoryByName(from);
          if (!match) {
            const known = (await getCategories()).map((c) => c.attributes.label).filter(Boolean).join(", ");
            throw new Error(`No profile called "${from}". Profiles: ${known}.`);
          }
          senderCategoryId = match.id;
        }
        const who = senderCategoryId ? ` from ${from}` : "";
        if (confirm !== true) {
          return {
            content: [
              {
                type: "text" as const,
                text: `NOT SENT. Preview: would post to everyone on all devices${who}${readAloud ? ", read aloud" : ", silent"}: "${text}"\n\nMessages cannot be deleted. If the user approves this exact text, call send_message again with confirm: true.`,
              },
            ],
          };
        }
        const sent = await createNudge({ body: text, readAloud: readAloud === true, senderCategoryId, timeZone: getConfig().timezone });
        const id = sent?.id ? ` [message ID: ${sent.id}]` : "";
        return {
          content: [{ type: "text" as const, text: `Posted to the frame${who}${readAloud ? " (read aloud)" : ""}: "${text}"${id}` }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatErrorForMcp(error) }], isError: true };
      }
    }
  );
  server.tool(
    "update_message",
    `Edit the text (and optionally the sender) of a message already on the frame.

Only messages sent to everyone on all devices and not repeating can be edited;
anything else must be edited in the Skylight app. Delivery time and read-aloud
setting are kept. The edit is visible on the frame immediately. Get the message
ID from get_messages (looks within 31 days either side of today).`,
    {
      messageId: z.string().describe("Numeric message ID from get_messages."),
      body: z.string().min(1).max(300).describe("New message text, up to 300 characters."),
      from: z.string().optional().describe("Optional new sender profile name. Omit to keep the current sender."),
    },
    async ({ messageId, body, from }) => {
      try {
        const id = assertNudgeId(messageId.trim());
        const text = body.trim();
        if (!text) throw new Error("Message is empty.");
        const { timezone } = getConfig();
        const existing = await findNudge(id, timezone);
        if (!existing) throw new Error(`No message with ID ${id} within 31 days of today.`);
        let senderCategoryId: string | undefined;
        if (from) {
          const match = await findCategoryByName(from);
          if (!match) {
            const known = (await getCategories()).map((c) => c.attributes.label).filter(Boolean).join(", ");
            throw new Error(`No profile called "${from}". Profiles: ${known}.`);
          }
          senderCategoryId = match.id;
        }
        await updateNudge({ existing, body: text, senderCategoryId, timeZone: timezone });
        return { content: [{ type: "text" as const, text: `Updated message ${id}: "${text}"` }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatErrorForMcp(error) }], isError: true };
      }
    }
  );
}

function describeRoute(n: NudgeResource, names: Map<string, string>): string {
  const a = n.attributes;
  const rel = n.relationships;
  const to = a.all_profiles
    ? "everyone"
    : (rel?.categories?.data ?? []).map((c) => names.get(c.id) ?? `profile ${c.id}`).join(", ");
  const from = rel?.sender_category?.data ? names.get(rel.sender_category.data.id) : undefined;
  const parts = [to ? `to ${to}` : "", from ? `from ${from}` : "", a.recurring ? "recurring" : "", a.all_devices ? "" : "selected devices"].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}
