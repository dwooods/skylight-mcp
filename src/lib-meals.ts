/**
 * Meal helpers for the library entry (experimental): the version fingerprint a meal read hands out.
 * Kept apart from lib-writes.ts so the read path (lib.ts) and the writes share one definition.
 */

import type { MealSittingResource } from "./api/endpoints/meals.js";
import { fnv } from "./lib-writes.js";

/**
 * The version of a meal as read: changes when its title, category, recipe, description, note, people
 * or repeat rule change. It does not include the list of days, so deleting or editing another
 * day of the same series does not make an older read stale. Skylight gives meals no update stamp,
 * so this is the only stale check there is.
 */
export function mealVersion(sitting: MealSittingResource): string {
  const a = sitting.attributes;
  const rel = sitting.relationships;
  const text = JSON.stringify([
    String(sitting.id),
    typeof a.summary === "string" ? a.summary : "",
    typeof a.description === "string" ? a.description.trim() : "",
    typeof a.note === "string" ? a.note.trim() : "",
    rel?.meal_category?.data?.id == null ? "" : String(rel.meal_category.data.id),
    rel?.meal_recipe?.data?.id == null ? "" : String(rel.meal_recipe.data.id),
    (rel?.profiles?.data ?? []).map((p) => String(p.id)).sort(),
    typeof a.rrule === "string" ? a.rrule : "",
    a.recurring === true,
  ]);
  return fnv(text, 0x811c9dc5) + fnv(text, 0x9747b28c);
}
