import { z } from "zod";
import { buildRrule, describeRepeat, normalizeRepeat, occurrences, parseRrule, repeatNotices, sameRepeat, RepeatInputError } from "../utils/meal-repeat.js";

/** The repeat options of Skylight's Plan Meal form (captured 2026-11-20). */
const repeatSchema = z
  .union([
    z.literal("weekly"),
    z
      .object({
        every: z.enum(["day", "week", "month", "year"]),
        interval: z.number().int().min(1).max(99).optional(),
        weekdays: z.array(z.enum(["SU", "MO", "TU", "WE", "TH", "FR", "SA"])).min(1).max(7).optional(),
        monthlyOn: z.enum(["date", "weekday"]).optional(),
        until: z.string().optional(),
      })
      .strict(),
  ])
  .describe('How the meal repeats: "weekly", or { every: day|week|month|year, interval?, weekdays? (week), monthlyOn? date|weekday (month), until? YYYY-MM-DD inclusive }');

const REPEAT_HELP = `- repeat: "weekly" (every week on date's weekday, no end), or an object as in Skylight's Plan Meal form:
  { every: "day" | "week" | "month" | "year", interval: 1-99 (default 1), weekdays: ["MO","WE",...] (week only; must include date's weekday; default that weekday), monthlyOn: "date" (same day of the month, default) or "weekday" (e.g. the 1st Monday) (month only), until: "YYYY-MM-DD" (inclusive; omit for no end) }.
  No occurrence count: turn "N times" into an until date. A day of the month from the 29th, or a 5th weekday, skips months that lack it.`;
import { checkMealText } from "../utils/meal-text.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  mealCategoryName,
  getMealCategories,
  getRecipes,
  getRecipe,
  createRecipe,
  updateRecipe,
  deleteRecipe,
  addRecipeToGroceryList,
  getMealSittingsWithProfiles,
  mealProfileNames,
  createMealSitting,
  findMealSitting,
  updateMealSitting,
  deleteMealSitting,
  mealKind,
  findSeriesStart,
  type MealDeleteScope,
  type MealEditScope,
} from "../api/endpoints/meals.js";
import { parseDate, formatDateForDisplay, getTodayDate, getDateOffset } from "../utils/dates.js";
import { addDays } from "../utils/schedule.js";
import { resolveProfileIds } from "../api/endpoints/categories.js";
import { formatErrorForMcp } from "../utils/errors.js";
import { getConfig } from "../config.js";
import { formatAttribute } from "../utils/redact.js";

export function registerMealTools(server: McpServer): void {
  // get_meal_categories tool
  server.tool(
    "get_meal_categories",
    `Get meal categories (Breakfast, Lunch, Dinner, etc.) - Plus subscription required.

Use this when:
- Finding category IDs for scheduling meals
- Seeing what meal times are available

Returns: List of meal categories with IDs.`,
    {},
    async () => {
      try {
        const categories = await getMealCategories();

        if (categories.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No meal categories found." }],
          };
        }

        const list = categories
          .map((cat) => `- ${mealCategoryName(cat)} (ID: ${cat.id})`)
          .join("\n");

        return {
          content: [{ type: "text" as const, text: `Meal categories:\n\n${list}` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // get_recipes tool
  server.tool(
    "get_recipes",
    `Get all saved recipes - Plus subscription required.

Use this when:
- Browsing available recipes
- Finding a recipe ID for meal planning

Returns: List of recipes with their details.`,
    {},
    async () => {
      try {
        const recipes = await getRecipes();

        if (recipes.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No recipes found." }],
          };
        }

        const list = recipes
          .map((recipe) => {
            const parts = [`- ${recipe.attributes.summary ?? "Untitled"} (ID: ${recipe.id})`];
            if (recipe.attributes.description) {
              parts.push(`  Description: ${recipe.attributes.description}`);
            }
            return parts.join("\n");
          })
          .join("\n\n");

        return {
          content: [{ type: "text" as const, text: `Recipes:\n\n${list}` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // get_recipe tool
  server.tool(
    "get_recipe",
    `Get details for a specific recipe - Plus subscription required.

Parameters:
- recipeId (required): ID of the recipe

Returns: Recipe details including description.`,
    {
      recipeId: z.string().describe("ID of the recipe"),
    },
    async ({ recipeId }) => {
      try {
        const recipe = await getRecipe(recipeId);

        const parts = [`Recipe: ${recipe.attributes.summary ?? "Untitled"}`];
        for (const [key, value] of Object.entries(recipe.attributes)) {
          if (value !== null && value !== undefined && key !== "summary") {
            parts.push(`${key}: ${formatAttribute(key, value)}`);
          }
        }

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // create_recipe tool
  server.tool(
    "create_recipe",
    `Create a new recipe - Plus subscription required.

Use this when:
- Adding a new family recipe
- Saving a meal for meal planning

Parameters:
- summary (required): Recipe name
- description: Recipe details or instructions
- mealCategoryId: Category ID (use get_meal_categories)

Returns: The created recipe.`,
    {
      summary: z.string().describe("Recipe name (e.g., 'Spaghetti Bolognese')"),
      description: z.string().optional().describe("Recipe details or instructions"),
      mealCategoryId: z.string().optional().describe("Meal category ID"),
    },
    async ({ summary, description, mealCategoryId }) => {
      try {
        const recipe = await createRecipe({ summary, description, mealCategoryId });
        return {
          content: [
            {
              type: "text" as const,
              text: `Created recipe "${summary}" (ID: ${recipe.id})`,
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

  // update_recipe tool
  server.tool(
    "update_recipe",
    `Update an existing recipe - Plus subscription required.

Parameters:
- recipeId (required): ID of the recipe
- summary: New name
- description: New description

Returns: The updated recipe.`,
    {
      recipeId: z.string().describe("ID of the recipe to update"),
      summary: z.string().optional().describe("New recipe name"),
      description: z.string().nullable().optional().describe("New description"),
    },
    async ({ recipeId, summary, description }) => {
      try {
        const updates: Parameters<typeof updateRecipe>[1] = {};
        if (summary !== undefined) updates.summary = summary;
        if (description !== undefined) updates.description = description;

        const recipe = await updateRecipe(recipeId, updates);
        return {
          content: [
            {
              type: "text" as const,
              text: `Updated recipe (ID: ${recipe.id})`,
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

  // delete_recipe tool
  server.tool(
    "delete_recipe",
    `Delete a recipe - Plus subscription required.

Parameters:
- recipeId (required): ID of the recipe to delete
- confirm: must be true to delete; without it nothing is deleted and a preview is returned.

Note: This permanently removes the recipe.`,
    {
      recipeId: z.string().describe("ID of the recipe to delete"),
      confirm: z.boolean().optional().default(false).describe("Must be true to delete; otherwise only a preview is returned"),
    },
    async ({ recipeId, confirm }) => {
      try {
        if (!confirm) {
          return {
            content: [{ type: "text" as const, text: `Preview only, nothing deleted. Would permanently delete recipe ${recipeId}. Call again with confirm: true after the user says yes.` }],
          };
        }
        await deleteRecipe(recipeId);
        return {
          content: [{ type: "text" as const, text: `Deleted recipe (ID: ${recipeId})` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // add_recipe_to_grocery_list tool
  server.tool(
    "add_recipe_to_grocery_list",
    `Add a recipe's ingredients to the grocery list - Plus subscription required.

Use this when:
- Planning to make a recipe and need to buy ingredients
- Adding meal ingredients to shopping list

Parameters:
- recipeId (required): ID of the recipe

Returns: Confirmation that ingredients were added.`,
    {
      recipeId: z.string().describe("ID of the recipe"),
    },
    async ({ recipeId }) => {
      try {
        await addRecipeToGroceryList(recipeId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Added recipe ingredients to grocery list`,
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

  // get_meal_sittings tool
  server.tool(
    "get_meal_sittings",
    `Get scheduled meals for a date range - Plus subscription required.

Use this when:
- Viewing the meal plan for the week
- Checking what's scheduled for dinner

Parameters:
- date: Start date (defaults to today)
- dateEnd: End date (defaults to 7 days from start)
- details: true to also print each meal's note and instructions (off by default; they can be long)

Returns: List of scheduled meals.`,
    {
      date: z.string().optional().describe("Start date (YYYY-MM-DD or 'today')"),
      dateEnd: z.string().optional().describe("End date (YYYY-MM-DD)"),
      details: z.boolean().optional().describe("Also print each meal's note and instructions"),
    },
    async ({ date, dateEnd, details }) => {
      try {
        const config = getConfig();
        const startDate = date ? parseDate(date, config.timezone) : getTodayDate(config.timezone);
        const endDate = dateEnd ? parseDate(dateEnd, config.timezone) : getDateOffset(7, config.timezone);

        const { sittings, profileLabels } = await getMealSittingsWithProfiles({
          dateMin: startDate,
          // Skylight's date_max leaves out the end day (a one-day query returns nothing),
          // so ask for one day more; the loop below drops anything past endDate.
          dateMax: addDays(endDate, 1),
        });

        if (sittings.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No meals scheduled for ${formatDateForDisplay(startDate)} to ${formatDateForDisplay(endDate)}.`,
              },
            ],
          };
        }

        // Resolve category ids to names once; recipes are shown by id (fetch with get_recipe).
        const categories = await getMealCategories().catch(() => []);
        const categoryName = new Map(categories.map((c) => [c.id, mealCategoryName(c)]));

        const rows: Array<{ date: string; line: string }> = [];
        for (const sitting of sittings) {
          const dates = sitting.attributes.instances?.length
            ? sitting.attributes.instances
            : [sitting.attributes.date ?? "unknown date"];
          const categoryId = sitting.relationships?.meal_category?.data?.id;
          const category = categoryId ? (categoryName.get(categoryId) ?? `category ${categoryId}`) : "uncategorised";
          const recipeId = sitting.relationships?.meal_recipe?.data?.id;
          const base = sitting.attributes.summary?.trim() || (recipeId ? `recipe ${recipeId}` : "(empty)");
          const forWhom = mealProfileNames(sitting, profileLabels);
          let what = forWhom.length ? `${base} (for: ${forWhom.join(", ")})` : base;
          if (mealKind(sitting) === "series") {
            const rule = parseRrule(typeof sitting.attributes.rrule === "string" ? sitting.attributes.rrule : null);
            if (rule) what += ` [repeats ${describeRepeat(rule)}]`;
          }
          const extra: string[] = [];
          if (details) {
            const n = typeof sitting.attributes.note === "string" ? sitting.attributes.note.trim() : "";
            const desc = typeof sitting.attributes.description === "string" ? sitting.attributes.description.trim() : "";
            if (desc) extra.push(`  instructions: ${desc}`);
            if (n) extra.push(`  note: ${n}`);
          }
          for (const d of dates) {
            if (d < startDate || d > endDate) continue;
            rows.push({
              date: d,
              line: [`- ${formatDateForDisplay(d)} ${category}: ${what}${recipeId ? ` (recipe ID: ${recipeId})` : ""} [sitting ID: ${sitting.id}]`, ...extra].join("\n"),
            });
          }
        }
        rows.sort((a, b) => a.date.localeCompare(b.date));
        const list = rows.map((r) => r.line).join("\n");

        return {
          content: [{ type: "text" as const, text: `Scheduled meals:\n\n${list}` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // create_meal_sitting tool
  server.tool(
    "create_meal_sitting",
    `Schedule a meal for a specific date - Plus subscription required.

Use this when:
- Planning meals for the week
- Scheduling a recipe for dinner

Parameters:
- date (required): Date for the meal (YYYY-MM-DD)
- mealCategoryId (required): Meal category ID (use get_meal_categories to find "Dinner" etc.)
- summary: What the meal is, as free text, e.g. "Thai green curry". No recipe needed.
- recipeId: A saved recipe to link instead of, or as well as, a summary.
${REPEAT_HELP}
- profiles: who the meal is for, by profile name (exact, case-insensitive), e.g. ["Alex"]. Several meals can share a day and category, one per person. Omit for an unassigned meal. An unknown name changes nothing and lists the valid names.

Give at least one of summary or recipeId.

Returns: The created meal sitting.`,
    {
      date: z.string().describe("Date for the meal (YYYY-MM-DD or 'today', 'tomorrow')"),
      mealCategoryId: z.string().describe("Meal category ID (e.g., ID for 'Dinner')"),
      summary: z.string().max(200).optional().describe("Meal name as free text, e.g. 'Sheet-pan fajitas'"),
      recipeId: z.string().optional().describe("Saved recipe ID to link"),
      repeat: repeatSchema.optional(),
      profiles: z.array(z.string().min(1)).max(10).optional().describe("Profile names the meal is for"),
    },
    async ({ date, mealCategoryId, summary, recipeId, repeat, profiles }) => {
      try {
        if (!summary?.trim() && !recipeId) {
          return {
            content: [{ type: "text" as const, text: "Give a summary (meal name) or a recipeId." }],
            isError: true,
          };
        }
        const config = getConfig();
        const mealDate = parseDate(date, config.timezone);
        let rule: ReturnType<typeof normalizeRepeat> | undefined;
        if (repeat !== undefined) {
          try {
            rule = normalizeRepeat(repeat, mealDate);
          } catch (error) {
            if (error instanceof RepeatInputError) return { content: [{ type: "text" as const, text: `${error.message} Nothing was created.` }], isError: true };
            throw error;
          }
        }

        const assigned = profiles?.length ? await resolveProfileIds(profiles) : undefined;
        const sitting = await createMealSitting({
          date: mealDate,
          mealCategoryId,
          summary: summary?.trim() || undefined,
          recipeId,
          ...(rule ? { rrule: buildRrule(rule, mealDate) } : {}),
          profileIds: assigned?.ids,
        });

        const what = sitting.attributes.summary?.trim() || summary?.trim() || `recipe ${recipeId}`;
        let repeatText = "";
        if (rule) {
          const o = occurrences(rule, mealDate);
          const skips = repeatNotices(rule, mealDate)[0];
          const stored = typeof sitting.attributes.rrule === "string" ? sitting.attributes.rrule : null;
          repeatText =
            `, repeating ${describeRepeat(rule)} (first: ${o.first.join(", ")}${o.last ? `; last: ${o.last}` : ""})` +
            (skips ? `. Note: no meal in month(s) ${skips.months.join(", ")} of the first year, which lack that day` : "") +
            (stored && !sameRepeat(stored, rule, mealDate) ? `. WARNING: Skylight's reply shows a different rule (${stored}); check get_meal_sittings` : "");
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Scheduled "${what}" for ${formatDateForDisplay(mealDate)}${repeatText}${assigned ? ` for ${assigned.labels.join(", ")}` : ""} (sitting ID: ${sitting.id})`,
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

  // update_meal_sitting tool
  server.tool(
    "update_meal_sitting",
    `Edit or move a scheduled meal - Plus subscription required.

Use this when:
- Renaming a planned meal, or changing its note or category
- Moving a meal to another day

Parameters:
- sittingId (required): from get_meal_sittings
- date (required): the meal's CURRENT date (YYYY-MM-DD), also from get_meal_sittings
- newDate: move the meal to this date
- summary: new meal name
- note: new note (family notes, caveats)
- description: the "Instructions or ingredients" field (recipe link, steps)
- mealCategoryId: move to another meal category (use get_meal_categories)
- profiles: who the meal is for, by profile name; replaces the current list. [] makes it unassigned. Omit to keep who it is for.

- repeat: a repeating meal with scope "all" only: its whole new rule, same shape as create_meal_sitting's repeat, taken from the series' start (e.g. to change or add the until date). Not for a one-off, a meal edited on its own, or scopes one/future.

- scope: required for a repeating meal. "one" changes only that date, which becomes a standalone meal with a NEW sitting ID that cannot be edited or deleted here afterwards. "future" changes that date and every later one: the series splits and the later part gets a NEW sitting ID. "all" changes every occurrence, past ones included, keeping the series' start.
- confirm: repeating meals only. Must be true to apply; without it nothing changes and the effect is shown.

Give at least one change. A repeating meal cannot be moved to another day here, and an occurrence that was already edited on its own cannot be edited here; use the Skylight app for those.

Returns: What changed.`,
    {
      sittingId: z.string().describe("Sitting ID from get_meal_sittings"),
      date: z.string().describe("The meal's current date (YYYY-MM-DD)"),
      newDate: z.string().optional().describe("Move the meal to this date (YYYY-MM-DD or 'tomorrow')"),
      summary: z.string().max(200).optional().describe("New meal name"),
      note: z.string().max(500).optional().describe("New note"),
      description: z.string().max(2000).optional().describe("New instructions or ingredients text (limit not confirmed against Skylight)"),
      mealCategoryId: z.string().optional().describe("New meal category ID"),
      profiles: z.array(z.string().min(1)).max(10).optional().describe("Profile names the meal is for; [] unassigns"),
      repeat: repeatSchema.optional(),
      scope: z.enum(["one", "future", "all"]).optional().describe("Repeating meals only: one, future or all"),
      confirm: z.boolean().optional().describe("Repeating meals only: set true to apply. Default: preview only."),
    },
    async ({ sittingId, date, newDate, summary, note, description, mealCategoryId, profiles, repeat, scope, confirm }) => {
      try {
        if (newDate === undefined && summary === undefined && note === undefined && description === undefined && mealCategoryId === undefined && profiles === undefined && repeat === undefined) {
          return {
            content: [{ type: "text" as const, text: "Nothing to change. Give newDate, summary, note, description, mealCategoryId, profiles or repeat." }],
            isError: true,
          };
        }
        if (summary !== undefined && !summary.trim()) {
          return { content: [{ type: "text" as const, text: "summary cannot be empty." }], isError: true };
        }
        const textErrors = checkMealText({ summary, note, description }).errors;
        if (textErrors.length) {
          return { content: [{ type: "text" as const, text: `Nothing was changed. Fix these first:\n- ${textErrors.join("\n- ")}` }], isError: true };
        }
        const config = getConfig();
        const current = parseDate(date, config.timezone);
        const target = newDate ? parseDate(newDate, config.timezone) : undefined;
        const assigned = profiles === undefined ? undefined : profiles.length ? await resolveProfileIds(profiles) : { ids: [] as string[], labels: [] as string[] };

        const existing = await findMealSitting(sittingId, current);
        if (!existing) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No meal with sitting ID ${sittingId} on ${formatDateForDisplay(current)}. Check get_meal_sittings for the ID and its current date.`,
              },
            ],
            isError: true,
          };
        }

        const was = existing.attributes.summary?.trim() || "(no name)";
        if (repeat !== undefined && (mealKind(existing) !== "series" || scope !== "all")) {
          return {
            content: [{ type: "text" as const, text: 'repeat can be changed only on a repeating meal, with scope "all" (the whole series). Making a one-off repeat, or changing the rule of one day or of this-and-later, is not supported here. Nothing was changed.' }],
            isError: true,
          };
        }
        let newRule: ReturnType<typeof normalizeRepeat> | undefined;
        let seriesStartFor: string | undefined;
        const describeChanges = (): string[] => {
          const out: string[] = [];
          if (newRule) {
            const o = occurrences(newRule, seriesStartFor!);
            out.push(`repeat set to ${describeRepeat(newRule)} (from ${formatDateForDisplay(seriesStartFor!)}: ${o.first.join(", ")}${o.last ? `; last ${o.last}` : ""})`);
          }
          if (summary !== undefined) out.push(`renamed "${was}" to "${summary.trim()}"`);
          if (target && target !== current) out.push(`moved from ${formatDateForDisplay(current)} to ${formatDateForDisplay(target)}`);
          if (note !== undefined) out.push("note updated");
          if (description !== undefined) out.push("instructions updated");
          if (mealCategoryId !== undefined) out.push(`category set to ${mealCategoryId}`);
          if (assigned) out.push(assigned.labels.length ? `now for ${assigned.labels.join(", ")}` : "unassigned");
          return out;
        };

        if (mealKind(existing) === "series") {
          const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
          if (!scope) {
            return fail(
              `"${was}" repeats. Say which occurrences to change with scope: "one" (only ${formatDateForDisplay(current)}), "future" (that date and every later one) or "all" (the whole series). Nothing was changed.`
            );
          }
          if (target && target !== current) {
            return fail("A repeating meal cannot be moved to another day here; use the Skylight app. Nothing was changed.");
          }
          let seriesStart: string | undefined;
          if (scope === "all") {
            seriesStart = (await findSeriesStart(sittingId, current)) ?? undefined;
            if (!seriesStart) {
              return fail(
                "Cannot edit the whole series: its start date could not be determined (Skylight does not state it, and this series may begin more than five years back). Editing without the real start would delete earlier occurrences. Use scope future, or the Skylight app. Nothing was changed."
              );
            }
          }
          if (repeat !== undefined && seriesStart) {
            const storedRule = typeof existing.attributes.rrule === "string" ? existing.attributes.rrule : null;
            if (parseRrule(storedRule)?.every === "other") {
              return fail("This series repeats in a way this server does not describe, so its rule cannot be changed here (a whole-series edit could drop parts of it). Use the Skylight app. Nothing was changed.");
            }
            try {
              newRule = normalizeRepeat(repeat, seriesStart);
            } catch (error) {
              if (error instanceof RepeatInputError) return fail(`${error.message} (The rule is taken from the series' start, ${formatDateForDisplay(seriesStart)}.) Nothing was changed.`);
              throw error;
            }
            if (sameRepeat(storedRule, newRule, seriesStart)) return fail("That rule is already stored. Nothing was changed.");
            seriesStartFor = seriesStart;
          }
          const effect: Record<MealEditScope, string> = {
            one: `change only the ${formatDateForDisplay(current)} occurrence of "${was}". It becomes a standalone meal with a NEW sitting ID, and this tool cannot edit or delete it afterwards (use the Skylight app); the series continues without it`,
            future: `change the ${formatDateForDisplay(current)} occurrence of "${was}" and every later one. The series splits: earlier dates stay under the current sitting ID, the rest moves to a NEW sitting ID`,
            all: `change EVERY occurrence of "${was}", past ones included${seriesStart ? ` (the series starts ${formatDateForDisplay(seriesStart)}, which is kept)` : ""}`,
          };
          const list = describeChanges();
          if (!confirm) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `NOT CHANGED. This would ${effect[scope]}: ${list.join("; ")}. Run again with confirm: true to apply.`,
                },
              ],
            };
          }
          const result = await updateMealSitting({
            existing,
            date: current,
            summary: summary?.trim(),
            note,
            description,
            mealCategoryId,
            profileIds: assigned?.ids,
            scope,
            seriesStart,
            ...(newRule && seriesStart ? { rrule: buildRrule(newRule, seriesStart) } : {}),
          });
          let tail = "";
          if (scope === "one" || scope === "future") {
            tail = result.sittingId
              ? ` The edited ${scope === "one" ? "occurrence" : "part of the series"} now has sitting ID ${result.sittingId}; the old ID ${sittingId} ${scope === "one" ? "keeps the rest of the series" : "now covers only the earlier dates"}.`
              : " Skylight did not show the new sitting ID in its reply; look it up with get_meal_sittings.";
          } else if (seriesStart) {
            const after = await findSeriesStart(sittingId, current);
            tail =
              after === seriesStart
                ? ` Checked afterwards: the series still starts ${formatDateForDisplay(seriesStart)}.`
                : ` WARNING: the series start now reads ${after ? formatDateForDisplay(after) : "unknown"}, not ${formatDateForDisplay(seriesStart)}. Check get_meal_sittings for missing earlier occurrences.`;
            if (newRule) {
              const back = await findMealSitting(sittingId, seriesStart);
              const stored = typeof back?.attributes.rrule === "string" ? back.attributes.rrule : null;
              tail += sameRepeat(stored, newRule, seriesStart)
                ? " Read back: Skylight stores the new rule."
                : ` WARNING: reading it back shows ${stored ? `the rule ${stored}` : "no rule"}, not the one asked. Check get_meal_sittings.`;
            }
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `Updated ${scope === "all" ? "the whole series" : scope === "future" ? `from ${formatDateForDisplay(current)} onward` : `the ${formatDateForDisplay(current)} occurrence of`} "${was}" (sitting ID: ${sittingId}): ${list.join("; ")}.${tail}`,
              },
            ],
          };
        }

        await updateMealSitting({
          existing,
          date: current,
          newDate: target,
          summary: summary?.trim(),
          note,
          description,
          mealCategoryId,
          profileIds: assigned?.ids,
        });

        const changes: string[] = [];
        if (summary !== undefined) changes.push(`renamed "${was}" to "${summary.trim()}"`);
        if (target && target !== current) changes.push(`moved from ${formatDateForDisplay(current)} to ${formatDateForDisplay(target)}`);
        if (note !== undefined) changes.push("note updated");
        if (description !== undefined) changes.push("instructions updated");
        if (mealCategoryId !== undefined) changes.push(`category set to ${mealCategoryId}`);
        if (assigned) changes.push(assigned.labels.length ? `now for ${assigned.labels.join(", ")}` : "unassigned");
        return {
          content: [{ type: "text" as const, text: `Updated meal (sitting ID: ${sittingId}): ${changes.join("; ")}.` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: formatErrorForMcp(error) }],
          isError: true,
        };
      }
    }
  );

  // delete_meal_sitting tool
  server.tool(
    "delete_meal_sitting",
    `Delete a scheduled meal - Plus subscription required. THIS CANNOT BE UNDONE.

Use this when:
- Removing a meal that was planned by mistake or is no longer happening

Parameters:
- sittingId (required): from get_meal_sittings
- date (required): the meal's date (YYYY-MM-DD)
- scope: for a repeating meal only. "one" (default) removes just that date; "future" removes that date and every later one, keeping earlier ones; "all" removes the whole series, past dates included.
- confirm: must be true to delete. Without it nothing is deleted and what would be removed is shown.

A meal that was edited on its own after being part of a series cannot be deleted here; use the Skylight app.

Returns: Confirmation that Skylight removed the meal.`,
    {
      sittingId: z.string().describe("Sitting ID from get_meal_sittings"),
      date: z.string().describe("The meal's date (YYYY-MM-DD)"),
      scope: z.enum(["one", "future", "all"]).optional().describe("Repeating meals only: one (default), future, or all"),
      confirm: z.boolean().optional().describe("Set true to actually delete. Default: preview only."),
    },
    async ({ sittingId, date, scope, confirm }) => {
      try {
        const config = getConfig();
        const day = parseDate(date, config.timezone);
        const existing = await findMealSitting(sittingId, day);
        if (!existing) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No meal with sitting ID ${sittingId} on ${formatDateForDisplay(day)}. Nothing deleted.`,
              },
            ],
            isError: true,
          };
        }
        const what = existing.attributes.summary?.trim() || "(no name)";
        const kind = mealKind(existing);
        if (kind === "detached") {
          return {
            content: [
              {
                type: "text" as const,
                text: `"${what}" on ${formatDateForDisplay(day)} was edited on its own and is detached from its series. It cannot be deleted here; use the Skylight app. Nothing deleted.`,
              },
            ],
            isError: true,
          };
        }
        const chosen: MealDeleteScope = scope ?? "one";
        const effect =
          kind === "one-off"
            ? `permanently delete "${what}" on ${formatDateForDisplay(day)}`
            : chosen === "one"
              ? `permanently delete only the ${formatDateForDisplay(day)} occurrence of the repeating meal "${what}"; the series continues`
              : chosen === "future"
                ? `permanently delete "${what}" on ${formatDateForDisplay(day)} and every later occurrence; earlier occurrences are kept`
                : `permanently delete the ENTIRE repeating series "${what}", every occurrence including past ones`;
        if (confirm !== true) {
          return {
            content: [
              {
                type: "text" as const,
                text: `NOT DELETED. This would ${effect} (sitting ID: ${sittingId}). Call again with confirm: true to proceed.`,
              },
            ],
          };
        }
        const removed = await deleteMealSitting(existing, day, chosen);
        return {
          content: [
            {
              type: "text" as const,
              text: removed
                ? `Deleted ${kind === "one-off" ? `"${what}" on ${formatDateForDisplay(day)}` : chosen === "all" ? `the whole series "${what}"` : chosen === "future" ? `"${what}" from ${formatDateForDisplay(day)} onward` : `the ${formatDateForDisplay(day)} occurrence of "${what}"`} (sitting ID: ${sittingId}).`
                : `Skylight accepted the request but did not confirm the removal of sitting ${sittingId}. Check get_meal_sittings.`,
            },
          ],
          ...(removed ? {} : { isError: true }),
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
