import { expect, it } from "vitest";
import { categoryIdFrom, liveSuite, LIVE_PREFIX, sittingIdFrom } from "./harness.js";

// Write round trip on a throwaway dinner far in the future: create, rename,
// move, preview-delete, delete, each verified by reading back. A cleanup
// removes the meal even if an assertion fails midway.

liveSuite("meal create, edit, move, delete", { tags: ["write", "meals"] }, (ctx) => {
  let id: string | null = null;
  let dinner: string | null = null;
  const from = (): string => ctx.daysFromToday(75);
  const to = (): string => ctx.daysFromToday(76);
  const name = `${LIVE_PREFIX}meal`;
  const renamed = `${LIVE_PREFIX}meal renamed`;

  async function listed(date: string): Promise<string> {
    const r = await ctx.call("get_meal_sittings", { date, dateEnd: date });
    return r.text;
  }

  it("finds the Dinner category", async () => {
    if (!ctx.hasPlus) return ctx.note("skipped: account has no Plus");
    const r = await ctx.call("get_meal_categories");
    dinner = categoryIdFrom(r.text, "Dinner");
    expect(dinner, "Dinner category id").not.toBeNull();
  });

  it("creates a throwaway meal", async () => {
    if (!dinner) return;
    const r = await ctx.call("create_meal_sitting", { date: from(), mealCategoryId: dinner, summary: name });
    expect(r.isError, r.text).toBe(false);
    id = sittingIdFrom(r.text);
    expect(id, "sitting id in the create response").not.toBeNull();
    ctx.onCleanup(async () => {
      if (!id) return;
      for (const date of [from(), to()]) {
        if ((await listed(date)).includes(`sitting ID: ${id}`)) {
          await ctx.call("delete_meal_sitting", { sittingId: id, date, confirm: true });
        }
      }
    });
    expect(await listed(from())).toContain(name);
  });

  it("renames it and the rename reads back", async () => {
    if (!id) return;
    const r = await ctx.call("update_meal_sitting", { sittingId: id, date: from(), summary: renamed });
    expect(r.isError, r.text).toBe(false);
    expect(await listed(from())).toContain(renamed);
  });

  it("moves it a day later and keeps the new name", async () => {
    if (!id) return;
    const r = await ctx.call("update_meal_sitting", { sittingId: id, date: from(), newDate: to() });
    expect(r.isError, r.text).toBe(false);
    expect(await listed(from())).not.toContain(`sitting ID: ${id}`);
    const moved = await listed(to());
    expect(moved).toContain(`sitting ID: ${id}`);
    expect(moved).toContain(renamed);
  });

  it("delete without confirm previews and removes nothing", async () => {
    if (!id) return;
    const r = await ctx.call("delete_meal_sitting", { sittingId: id, date: to() });
    expect(r.text).toContain("NOT DELETED");
    expect(await listed(to())).toContain(`sitting ID: ${id}`);
  });

  it("delete with confirm removes it and Skylight agrees", async () => {
    if (!id) return;
    const r = await ctx.call("delete_meal_sitting", { sittingId: id, date: to(), confirm: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/^Deleted/);
    expect(await listed(to())).not.toContain(`sitting ID: ${id}`);
  });
});
