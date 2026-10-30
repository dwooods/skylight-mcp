import { expect, it } from "vitest";
import { liveSuite } from "./harness.js";

// Guards: bad input is refused before anything is written. These calls are
// built to be rejected, so no data changes even if a guard were missing a
// real record: the ids below do not exist and cannot parse as real ones.

liveSuite("write guards refuse bad input", { tags: ["read", "guards"] }, (ctx) => {
  it("update_meal_sitting on an unknown sitting is refused", async () => {
    if (!ctx.hasPlus) return ctx.note("skipped: account has no Plus");
    const r = await ctx.call("update_meal_sitting", { sittingId: "999999999999", date: ctx.today(), summary: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No meal/i);
  });

  it("update_meal_sitting refuses an id that is not numeric", async () => {
    if (!ctx.hasPlus) return ctx.note("skipped: account has no Plus");
    const r = await ctx.call("update_meal_sitting", { sittingId: "1/../chores", date: ctx.today(), summary: "x" });
    expect(r.isError).toBe(true);
  });

  it("delete_meal_sitting on an unknown sitting deletes nothing", async () => {
    if (!ctx.hasPlus) return ctx.note("skipped: account has no Plus");
    const r = await ctx.call("delete_meal_sitting", { sittingId: "999999999999", date: ctx.today(), confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/^Deleted/);
  });
});
