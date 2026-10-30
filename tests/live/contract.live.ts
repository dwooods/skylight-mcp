import { expect, it } from "vitest";
import { MEAL_EDIT_API_VERSION } from "../../src/api/endpoints/meals.js";
import { getNudges } from "../../src/api/endpoints/messages.js";
import { liveSuite } from "./harness.js";

// Contract checks: the response shapes our code depends on. This is the drift
// detector. If a Skylight web release changes a field, it fails here with the
// field name, long before a family-facing tool misreports something.
// Read-only.

interface Sitting {
  id?: unknown;
  type?: unknown;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
}

liveSuite("response shapes our tools rely on", { tags: ["read", "contract"] }, (ctx) => {
  it("meal sittings carry the fields the edit and delete guards read", async () => {
    if (!ctx.hasPlus) return ctx.note("skipped: account has no Plus");
    const response = await ctx.client().request<{ data?: Sitting[] }>("/api/frames/{frameId}/meals/sittings", {
      method: "GET",
      params: {
        date_min: ctx.today(),
        date_max: ctx.daysFromToday(120),
        include: "meal_category,meal_recipe,profiles",
      },
      apiVersion: MEAL_EDIT_API_VERSION,
    });
    const sittings = response.data ?? [];
    if (sittings.length === 0) return ctx.note("no meals in the next 120 days; shape not checked");
    for (const s of sittings) {
      expect(s.type).toBe("meal_sitting");
      expect(typeof s.id).toBe("string");
      const a = s.attributes ?? {};
      expect(Array.isArray(a.instances), "attributes.instances").toBe(true);
      expect("rrule" in a, "attributes.rrule present").toBe(true);
      expect(typeof a.recurring, "attributes.recurring").toBe("boolean");
      expect("summary" in a, "attributes.summary present").toBe(true);
      expect(s.relationships && "meal_category" in s.relationships, "relationships.meal_category").toBe(true);
    }
  });

  it("messages carry all_profiles, all_devices and voice_kind under the messages API version", async () => {
    const nudges = await getNudges(ctx.daysFromToday(-31), ctx.daysFromToday(31), ctx.timezone);
    if (nudges.length === 0) return ctx.note("no messages in the last or next 31 days; shape not checked");
    for (const n of nudges) {
      expect(typeof n.attributes.all_profiles, "attributes.all_profiles").toBe("boolean");
      expect(typeof n.attributes.all_devices, "attributes.all_devices").toBe("boolean");
      expect("voice_kind" in n.attributes, "attributes.voice_kind present").toBe(true);
    }
  });

  it("get_messages never returns presigned audio URLs", async () => {
    const result = await ctx.call("get_messages", { date: ctx.daysFromToday(-15), dateEnd: ctx.daysFromToday(15) });
    expect(result.isError).toBe(false);
    expect(result.text).not.toMatch(/X-Amz|audio_url|https?:\/\/[^\s]*amazonaws/i);
  });

  it("get_week_overview does not expose email addresses", async () => {
    const result = await ctx.call("get_week_overview");
    expect(result.isError).toBe(false);
    expect(result.text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  });
});
