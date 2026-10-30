/**
 * Normalise a list response. Skylight's endpoints mostly return JSON:API
 * ({ data: [...] }), but a few (colors, reward points) did not match that on a
 * real account. Accept a bare array, { data: [...] } or { data: {...} }; for
 * anything else fail with the top-level KEYS only (never values, which can
 * hold personal data) so the real shape can be learned from the error.
 */
export function resourceList<T>(response: unknown, label: string): T[] {
  if (Array.isArray(response)) return response as T[];
  if (response && typeof response === "object") {
    const data = (response as { data?: unknown }).data;
    if (Array.isArray(data)) return data as T[];
    if (data && typeof data === "object") return [data as T];
    const keys = Object.keys(response as object).join(", ") || "none";
    throw new Error(`${label}: unexpected response shape (top-level keys: ${keys})`);
  }
  throw new Error(`${label}: unexpected response shape (${typeof response})`);
}

/** Attributes of a resource, tolerating flat items that carry no `attributes`. */
export function attributesOf(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== "object") return {};
  const obj = item as { attributes?: unknown };
  if (obj.attributes && typeof obj.attributes === "object") return obj.attributes as Record<string, unknown>;
  const rest: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  delete rest.id;
  delete rest.type;
  return rest;
}
