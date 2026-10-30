import { getClient } from "../client.js";
import type { CategoriesResponse, CategoryResource } from "../types.js";

// Cache for categories (family members)
let categoriesCache: CategoryResource[] | null = null;

/**
 * Get all categories (family members/profiles)
 */
export async function getCategories(useCache = true): Promise<CategoryResource[]> {
  if (useCache && categoriesCache) {
    return categoriesCache;
  }

  const client = getClient();
  const response = await client.get<CategoriesResponse>("/api/frames/{frameId}/categories");
  categoriesCache = response.data;
  return response.data;
}

/**
 * Clear the categories cache
 */
export function clearCategoriesCache(): void {
  categoriesCache = null;
}

/**
 * Find a category by name (case-insensitive partial match)
 * Categories represent family members like "Casey", "Mom", "Kids", etc.
 */
export async function findCategoryByName(name: string): Promise<CategoryResource | undefined> {
  const categories = await getCategories();
  const lowerName = name.toLowerCase();

  return categories.find((cat) => {
    const label = cat.attributes.label?.toLowerCase();
    return label && (label === lowerName || label.includes(lowerName));
  });
}

/**
 * Get categories that are linked to profiles (actual family members)
 */
export async function getFamilyMembers(): Promise<CategoryResource[]> {
  const categories = await getCategories();
  return categories.filter((cat) => cat.attributes.linked_to_profile);
}

/**
 * Get categories selected for the chore chart
 */
export async function getChoreChartCategories(): Promise<CategoryResource[]> {
  const categories = await getCategories();
  return categories.filter((cat) => cat.attributes.selected_for_chore_chart);
}

/**
 * Turn profile names into category IDs. Exact match, case-insensitive, no partial
 * matching: findCategoryByName would treat "Alex" as a match for any longer name.
 * Unknown names fail with the valid list so nothing is ever sent to a guess.
 */
export async function resolveProfileIds(names: string[]): Promise<{ ids: string[]; labels: string[] }> {
  const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (wanted.length === 0) throw new Error("Give at least one profile name.");
  const all = await getCategories();
  const linked = all.filter((c) => c.attributes.linked_to_profile);
  const pool = linked.length > 0 ? linked : all;
  const ids: string[] = [];
  const labels: string[] = [];
  for (const name of wanted) {
    const hits = pool.filter((c) => c.attributes.label?.toLowerCase() === name.toLowerCase());
    if (hits.length !== 1) {
      const known = pool.map((c) => c.attributes.label).filter(Boolean).join(", ");
      throw new Error(
        hits.length === 0
          ? `No profile called "${name}". Profiles: ${known}.`
          : `"${name}" matches ${hits.length} profiles; rename one in Skylight. Profiles: ${known}.`
      );
    }
    if (!ids.includes(hits[0]!.id)) {
      ids.push(hits[0]!.id);
      labels.push(hits[0]!.attributes.label ?? name);
    }
  }
  return { ids, labels };
}
