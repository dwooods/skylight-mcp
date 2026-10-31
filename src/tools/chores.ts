import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getChores, createChore, updateChore, deleteChore, isChoreDone, parseOccurrenceId, completeChoreOccurrence } from "../api/endpoints/chores.js";
import { resolveProfile } from "../api/endpoints/categories.js";
import { getTodayDate, getDateOffset, parseDate, parseTime, formatDateForDisplay } from "../utils/dates.js";
import { formatErrorForMcp } from "../utils/errors.js";
import { getConfig } from "../config.js";

export function registerChoreTools(server: McpServer): void {
  // get_chores tool
  server.tool(
    "get_chores",
    `Get chores from Skylight.

Use this to answer:
- "What chores do I need to do today?"
- "Show me this week's chores"
- "What's on the chore chart?"
- "What chores does [name] have?"

Returns chores with their assignees, due dates, and completion status.`,
    {
      date: z
        .string()
        .optional()
        .describe("Start date (YYYY-MM-DD or 'today'). Defaults to today."),
      dateEnd: z
        .string()
        .optional()
        .describe("End date (YYYY-MM-DD). Defaults to 7 days from start."),
      includeLate: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include overdue chores from past dates"),
      assignee: z
        .string()
        .optional()
        .describe("Filter by family member name (e.g., 'Casey', 'Mom')"),
      status: z
        .enum(["pending", "completed", "all"])
        .optional()
        .default("pending")
        .describe("Filter by completion status"),
    },
    async ({ date, dateEnd, includeLate, assignee, status }) => {
      try {
        const config = getConfig();
        const startDate = date ? parseDate(date, config.timezone) : getTodayDate(config.timezone);
        const endDate = dateEnd ? parseDate(dateEnd, config.timezone) : getDateOffset(7, config.timezone);

        const result = await getChores({
          after: startDate,
          before: endDate,
          includeLate: includeLate ?? true,
          includeUpForGrabs: true,
        });

        let chores = result.chores;

        // Filter by status
        if (status !== "all") {
          const wantDone = status === "completed";
          chores = chores.filter((chore) => isChoreDone(chore.attributes.status) === wantDone);
        }

        // Build category lookup for assignee names
        const categoryMap = new Map(result.categories.map((c) => [c.id, c.attributes.label ?? "Unknown"]));

        // Filter by assignee if specified: exact profile name, so "Ben" never matches "Benjamin"
        if (assignee) {
          const wanted = (await resolveProfile(assignee)).id;
          chores = chores.filter((chore) => chore.relationships?.category?.data?.id === wanted);
        }

        if (chores.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No ${status === "all" ? "" : status + " "}chores found${assignee ? ` for ${assignee}` : ""}.`,
              },
            ],
          };
        }

        // Format chores for display
        const choreList = chores
          .map((chore) => {
            const attrs = chore.attributes;
            const categoryId = chore.relationships?.category?.data?.id;
            const assigneeName = categoryId ? categoryMap.get(categoryId) : null;

            const parts = [
              `- ${attrs.summary}`,
              `  Date: ${formatDateForDisplay(attrs.start)}${attrs.start_time ? ` at ${attrs.start_time}` : ""}`,
              `  Status: ${attrs.status}`,
            ];

            if (assigneeName) {
              parts.push(`  Assigned to: ${assigneeName}`);
            } else if (attrs.up_for_grabs) {
              parts.push(`  Assigned to: nobody (up for grabs)`);
            }

            if (attrs.routine) {
              parts.push(`  Routine: Yes (a habit that repeats; shows on the routine chart)`);
            }

            if (attrs.recurring) {
              parts.push(`  Recurring: Yes${attrs.recurrence_set ? ` (${attrs.recurrence_set})` : ""}`);
            }

            if (attrs.reward_points) {
              parts.push(`  Reward points: ${attrs.reward_points}`);
            }

            return parts.join("\n");
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Chores:\n\n${choreList}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatErrorForMcp(error),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // create_chore tool
  server.tool(
    "create_chore",
    `Add a new chore to Skylight.

Use this when the user wants to:
- Add a new task like "empty the dishwasher"
- Assign chores to family members
- Create recurring chores

The chore will appear on the Skylight display.`,
    {
      summary: z.string().describe("Chore description (e.g., 'Empty the dishwasher')"),
      date: z
        .string()
        .optional()
        .describe("Due date (YYYY-MM-DD or 'today', 'tomorrow', day name). Defaults to today."),
      time: z
        .string()
        .optional()
        .describe("Due time (e.g., '10:00 AM', '14:30'). Optional."),
      assignee: z
        .string()
        .optional()
        .describe("Family member to assign (e.g., 'Casey', 'Mom', 'Kids')"),
      recurring: z
        .boolean()
        .optional()
        .default(false)
        .describe("Is this a recurring chore?"),
      recurrencePattern: z
        .string()
        .optional()
        .describe("For recurring: 'daily', 'weekly', 'weekdays', or RRULE string"),
      rewardPoints: z
        .number()
        .optional()
        .describe("Reward points for completing this chore"),
    },
    async ({ summary, date, time, assignee, recurring, recurrencePattern, rewardPoints }) => {
      try {
        const config = getConfig();
        const choreDate = date ? parseDate(date, config.timezone) : getTodayDate(config.timezone);

        // Resolve assignee to category ID
        let categoryId: string | undefined;
        if (assignee) categoryId = (await resolveProfile(assignee)).id;

        // Convert simple recurrence patterns to RRULE
        let recurrenceSet: string | undefined;
        if (recurring && recurrencePattern) {
          const pattern = recurrencePattern.toLowerCase();
          if (pattern === "daily") {
            recurrenceSet = "RRULE:FREQ=DAILY";
          } else if (pattern === "weekly") {
            recurrenceSet = "RRULE:FREQ=WEEKLY";
          } else if (pattern === "weekdays") {
            recurrenceSet = "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
          } else if (pattern.startsWith("RRULE:")) {
            recurrenceSet = pattern;
          } else {
            recurrenceSet = recurrencePattern;
          }
        }

        const chore = await createChore({
          summary,
          start: choreDate,
          startTime: time ? parseTime(time) : undefined,
          categoryId,
          recurring: recurring ?? false,
          recurrenceSet,
          rewardPoints,
        });

        const parts = [
          `Created chore: "${chore.attributes.summary}"`,
          `Date: ${formatDateForDisplay(chore.attributes.start)}${chore.attributes.start_time ? ` at ${chore.attributes.start_time}` : ""}`,
        ];

        if (assignee) {
          parts.push(`Assigned to: ${assignee}`);
        }

        if (chore.attributes.recurring) {
          parts.push(`Recurring: Yes`);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: parts.join("\n"),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatErrorForMcp(error),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // update_chore tool
  server.tool(
    "update_chore",
    `Update an existing chore in Skylight.

Use this when:
- (To mark a routine or chore done, use complete_chore, not this tool)
- Changing chore assignment: "Reassign the trash to Casey"
- Updating chore details: "Change the time for the homework chore"

Parameters:
- choreId (required): ID of the chore (from get_chores)
- summary: New description for the chore
- status: not supported here; use complete_chore
- date: New due date
- time: New due time
- assignee: New family member assignment

Returns: The updated chore details.`,
    {
      choreId: z.string().describe("ID of the chore to update"),
      summary: z.string().optional().describe("New chore description"),
      status: z.enum(["pending", "completed"]).optional().describe("Not supported: use complete_chore to mark a chore done or not done"),
      date: z.string().optional().describe("New due date (YYYY-MM-DD or 'today', 'tomorrow')"),
      time: z.string().nullable().optional().describe("New due time (e.g., '10:00 AM', or null to clear)"),
      assignee: z.string().nullable().optional().describe("New family member assignment (or null to unassign)"),
      rewardPoints: z.number().nullable().optional().describe("New reward points (or null to clear)"),
    },
    async ({ choreId, summary, status, date, time, assignee, rewardPoints }) => {
      try {
        if (status !== undefined) {
          return {
            content: [
              {
                type: "text" as const,
                text: "update_chore cannot change completion: Skylight records completions on a separate endpoint, and sending a status here does not award stars or update streaks. Use complete_chore with the chore's id from get_chores. Nothing was changed.",
              },
            ],
            isError: true,
          };
        }
        const config = getConfig();
        const updates: Parameters<typeof updateChore>[1] = {};

        if (summary !== undefined) updates.summary = summary;
        if (date !== undefined) updates.start = parseDate(date, config.timezone);
        if (time !== undefined) updates.startTime = time ? parseTime(time) : null;
        if (rewardPoints !== undefined) updates.rewardPoints = rewardPoints;

        // Handle assignee
        if (assignee !== undefined) {
          if (assignee === null) {
            updates.categoryId = null;
          } else {
            updates.categoryId = (await resolveProfile(assignee)).id;
          }
        }

        const chore = await updateChore(choreId, updates);
        return {
          content: [
            {
              type: "text" as const,
              text: `Updated chore: "${chore.attributes.summary}"`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // complete_chore tool (local only: see LOCAL_ONLY_TOOLS in registry.ts)
  server.tool(
    "complete_chore",
    `Mark one occurrence of a recurring chore or routine complete, or undo that.

This is visible to the family and has real effects: completing a chore with a reward awards stars, and completing a routine extends its streak, both shown on the Skylight display. Undoing restores the status and the stars, but a routine's "longest streak" record cannot be reduced.

Without confirm: true this only previews what would happen and changes nothing. Show the preview to the user and get an explicit yes before calling again with confirm: true.

Parameters:
- choreId (required): the occurrence id from get_chores. For recurring chores and routines it looks like 12345-2026-11-03-0600. One-off chores are not supported.
- complete: true (default) to mark done, false to mark not done
- confirm: must be true to make the change`,
    {
      choreId: z.string().describe("Occurrence id from get_chores, e.g. 12345-2026-11-03-0600"),
      complete: z.boolean().optional().default(true).describe("true to mark complete, false to mark not complete"),
      confirm: z.boolean().optional().default(false).describe("Must be true to make the change; otherwise a preview is returned"),
    },
    async ({ choreId, complete, confirm }) => {
      try {
        const occurrence = parseOccurrenceId(choreId);
        if (!occurrence) {
          return {
            content: [
              {
                type: "text" as const,
                text: `"${choreId}" is not a recurring-chore occurrence id (expected something like 12345-2026-11-03-0600, from get_chores). Completing one-off chores is not supported yet. Nothing was changed.`,
              },
            ],
            isError: true,
          };
        }

        const verb = complete ? "mark complete" : "mark not complete";
        if (!confirm) {
          const warnings = complete
            ? "This shows on the family's Skylight display, awards any stars attached to the chore, and extends a routine's streak."
            : "This shows on the family's Skylight display and removes the stars and streak credit for that day. A routine's longest-streak record is not reduced.";
          return {
            content: [
              {
                type: "text" as const,
                text: `Preview only, nothing changed. Would ${verb} occurrence ${occurrence.instanceDate} ${occurrence.instanceTime} of chore series ${occurrence.seriesId}.\n${warnings}\nCall again with confirm: true after the user says yes.`,
              },
            ],
          };
        }

        const config = getConfig();
        const result = await completeChoreOccurrence(occurrence, complete, getTodayDate(config.timezone));
        const lines = [`${complete ? "Marked complete" : "Marked not complete"}: "${result.summary ?? occurrence.seriesId}" (${occurrence.instanceDate} ${occurrence.instanceTime}). Status now: ${result.status ?? "unknown"}.`];
        if (result.pointsBalance !== null) lines.push(`Points balance: ${result.pointsBalance}`);
        if (result.currentStreak !== null) lines.push(`Streak: ${result.currentStreak} (longest ${result.longestStreak ?? "unknown"})`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // delete_chore tool
  server.tool(
    "delete_chore",
    `Delete a chore from Skylight.

Use this when:
- Removing an old or irrelevant chore
- Deleting a chore that was added by mistake

Parameters:
- choreId (required): ID of the chore to delete (from get_chores)
- confirm: must be true to delete; without it nothing is deleted and a preview is returned.

Note: This permanently removes the chore. Occurrences of recurring chores and routines (ids like 12345-2026-11-03-0600) are refused; delete those in the Skylight app.`,
    {
      choreId: z.string().describe("ID of the chore to delete"),
      confirm: z.boolean().optional().default(false).describe("Must be true to delete; otherwise only a preview is returned"),
    },
    async ({ choreId, confirm }) => {
      try {
        // The app asks "this and future" vs "all in series" when deleting a recurring chore;
        // what DELETE /chores/{id} does to a series is not captured, so refuse rather than guess.
        if (parseOccurrenceId(choreId) !== null) {
          return {
            content: [
              {
                type: "text" as const,
                text: `"${choreId}" is an occurrence of a recurring chore or routine. Deleting those is not supported yet, because Skylight asks whether to delete "this and future" or "all in series" and that call has not been captured. Delete it in the Skylight app. Nothing was changed.`,
              },
            ],
            isError: true,
          };
        }
        if (!confirm) {
          return {
            content: [{ type: "text" as const, text: `Preview only, nothing deleted. Would permanently delete chore ${choreId}. Call again with confirm: true after the user says yes.` }],
          };
        }
        await deleteChore(choreId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted chore (ID: ${choreId})`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );
}
