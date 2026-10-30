import { getClient } from "../client.js";

// Meal types
export interface MealCategoryResource {
  type: "meal_category";
  id: string;
  attributes: {
    /** Skylight calls the display name `label`; older code assumed `name`. */
    label?: string;
    name?: string;
    color?: string;
    position?: number;
    [key: string]: unknown;
  };
}

/** Display name of a meal category, whichever field the API used. */
export function mealCategoryName(category: MealCategoryResource): string {
  return category.attributes.label ?? category.attributes.name ?? "Unnamed";
}

export interface MealRecipeResource {
  type: "meal_recipe";
  id: string;
  attributes: {
    summary?: string;
    description?: string | null;
    [key: string]: unknown;
  };
  relationships?: {
    meal_category?: {
      data: { type: string; id: string } | null;
    };
  };
}

export interface MealSittingResource {
  type: "meal_sitting";
  id: string;
  attributes: {
    /** Free-text meal name, e.g. "Thai green curry". May be empty when a recipe is linked. */
    summary?: string | null;
    /** Dates (YYYY-MM-DD) this sitting appears on. */
    instances?: string[];
    date?: string;
    meal_time?: string;
    [key: string]: unknown;
  };
  relationships?: {
    meal_recipe?: {
      data: { type: string; id: string } | null;
    };
    meal_category?: {
      data: { type: string; id: string } | null;
    };
  };
}

interface MealCategoriesResponse {
  data: MealCategoryResource[];
}

interface MealRecipesResponse {
  data: MealRecipeResource[];
  included?: MealCategoryResource[];
}

interface MealRecipeResponse {
  data: MealRecipeResource;
  included?: MealCategoryResource[];
}

interface MealSittingsResponse {
  data: MealSittingResource[];
  included?: MealRecipeResource[];
}

/**
 * Get meal categories (Breakfast, Lunch, Dinner, etc.)
 */
export async function getMealCategories(): Promise<MealCategoryResource[]> {
  const client = getClient();
  const response = await client.get<MealCategoriesResponse>(
    "/api/frames/{frameId}/meals/categories"
  );
  return response.data;
}

export interface GetRecipesOptions {
  include?: string;
}

/**
 * Get all recipes
 */
export async function getRecipes(options: GetRecipesOptions = {}): Promise<MealRecipeResource[]> {
  const client = getClient();
  const response = await client.get<MealRecipesResponse>(
    "/api/frames/{frameId}/meals/recipes",
    { include: options.include ?? "meal_category" }
  );
  return response.data;
}

/**
 * Get a specific recipe
 */
export async function getRecipe(recipeId: string): Promise<MealRecipeResource> {
  const client = getClient();
  const response = await client.get<MealRecipeResponse>(
    `/api/frames/{frameId}/meals/recipes/${recipeId}`,
    { include: "meal_category" }
  );
  return response.data;
}

export interface CreateRecipeOptions {
  summary: string;
  description?: string;
  mealCategoryId?: string;
}

/**
 * Create a new recipe
 */
export async function createRecipe(options: CreateRecipeOptions): Promise<MealRecipeResource> {
  const client = getClient();
  const body: Record<string, unknown> = {
    summary: options.summary,
    description: options.description ?? null,
  };
  if (options.mealCategoryId) {
    body.meal_category_id = options.mealCategoryId;
  }
  const response = await client.post<MealRecipeResponse>(
    "/api/frames/{frameId}/meals/recipes",
    body
  );
  return response.data;
}

export interface UpdateRecipeOptions {
  summary?: string;
  description?: string | null;
  mealCategoryId?: string | null;
}

/**
 * Update a recipe
 */
export async function updateRecipe(
  recipeId: string,
  options: UpdateRecipeOptions
): Promise<MealRecipeResource> {
  const client = getClient();
  const body: Record<string, unknown> = {};
  if (options.summary !== undefined) body.summary = options.summary;
  if (options.description !== undefined) body.description = options.description;
  if (options.mealCategoryId !== undefined) body.meal_category_id = options.mealCategoryId;

  const response = await client.request<MealRecipeResponse>(
    `/api/frames/{frameId}/meals/recipes/${recipeId}`,
    { method: "PATCH", body }
  );
  return response.data;
}

/**
 * Delete a recipe
 */
export async function deleteRecipe(recipeId: string): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/meals/recipes/${recipeId}`, {
    method: "DELETE",
  });
}

/**
 * Add recipe ingredients to grocery list
 */
export async function addRecipeToGroceryList(recipeId: string): Promise<void> {
  const client = getClient();
  await client.post(
    `/api/frames/{frameId}/meals/recipes/${recipeId}/add_to_grocery_list`,
    {}
  );
}

export interface GetMealSittingsOptions {
  dateMin?: string;
  dateMax?: string;
}

/**
 * Get meal sittings (scheduled meals)
 */
export async function getMealSittings(
  options: GetMealSittingsOptions = {}
): Promise<MealSittingResource[]> {
  const client = getClient();
  const params: Record<string, string | undefined> = {};
  if (options.dateMin) params.date_min = options.dateMin;
  if (options.dateMax) params.date_max = options.dateMax;

  const response = await client.get<MealSittingsResponse>(
    "/api/frames/{frameId}/meals/sittings",
    params
  );
  return response.data;
}

export interface CreateMealSittingOptions {
  date: string;
  mealCategoryId: string;
  /** Free-text meal name. Either this or recipeId should be given. */
  summary?: string;
  recipeId?: string;
}

/**
 * Create a meal sitting (schedule a meal)
 */
export async function createMealSitting(
  options: CreateMealSittingOptions
): Promise<MealSittingResource> {
  const client = getClient();
  const body: Record<string, unknown> = {
    date: options.date,
    meal_category_id: options.mealCategoryId,
  };
  if (options.summary) {
    body.summary = options.summary;
  }
  if (options.recipeId) {
    body.meal_recipe_id = options.recipeId;
  }

  // The API answers a create with a list envelope (one element), unlike GET by id.
  const response = await client.post<{ data: MealSittingResource | MealSittingResource[] }>(
    "/api/frames/{frameId}/meals/sittings",
    body
  );
  const data = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!data) throw new Error("Skylight returned an empty response when creating the meal sitting");
  return data;
}
