import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getNudges, type NudgeResource } from "../api/endpoints/messages.js";
import { getCategories } from "../api/endpoints/categories.js";
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
