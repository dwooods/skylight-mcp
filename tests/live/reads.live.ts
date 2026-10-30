import { expect, it } from "vitest";
import { liveSuite } from "./harness.js";

// Smoke: every read tool answers without an error against the real frame.
// No data is changed. Plus-only tools are skipped on a free account.

const PLUS_ONLY = new Set(["get_meal_categories", "get_meal_sittings", "get_recipes", "get_rewards", "get_reward_points"]);

const READS = [
  "get_frame_info",
  "get_family_members",
  "get_devices",
  "get_colors",
  "get_avatars",
  "get_source_calendars",
  "get_calendar_events",
  "get_chores",
  "get_lists",
  "get_meal_categories",
  "get_meal_sittings",
  "get_recipes",
  "get_rewards",
  "get_reward_points",
  "get_messages",
  "get_week_overview",
  "find_conflicts",
  "find_free_slots",
];

liveSuite("read tools answer", { tags: ["read", "smoke"] }, (ctx) => {
  for (const tool of READS) {
    it(tool, async () => {
      if (PLUS_ONLY.has(tool) && !ctx.hasPlus) {
        ctx.note(`${tool} skipped: account has no Plus`);
        return;
      }
      const result = await ctx.call(tool);
      expect(result.isError, `${tool}: ${result.text.slice(0, 200)}`).toBe(false);
      expect(result.text.length).toBeGreaterThan(0);
    });
  }
});
