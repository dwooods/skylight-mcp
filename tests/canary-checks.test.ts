import { describe, expect, it } from "vitest";
import { runChecks, summarize } from "../src/canary/checks.js";
import type { Skylight } from "../src/lib.js";
import { AuthenticationError } from "../src/utils/errors.js";

const input = { from: "2037-03-01", to: "2037-03-07", dinnerName: "Dinner" };

function sky(over: Record<string, unknown> = {}): Skylight {
  const base = {
    profiles: { list: async () => [{ id: "1", label: "SECRET-NAME", color: null }] },
    meals: {
      categories: async () => [{ id: "3", name: "Dinner" }],
      sittings: async () => [{ id: "5", dates: ["2037-03-02"], title: "SECRET-MEAL", category: "Dinner", recipeId: null, recurring: false }],
    },
    calendar: {
      events: async () => [{ id: "e1", title: "SECRET-EVENT", start: "2037-03-02T10:00:00-08:00" }],
      sources: async () => [{ id: "s1", label: "x", kind: "feed" }],
    },
  };
  return { ...base, ...over } as unknown as Skylight;
}

const failing = (id: string) => async () => {
  throw new Error(`SECRET-ERROR in ${id}`);
};

describe("canary checks", () => {
  it("passes on healthy data", async () => {
    const results = await runChecks(sky(), input);
    expect(results.map((r) => [r.id, r.ok])).toEqual([
      ["profiles", true],
      ["meal-categories", true],
      ["meals-week", true],
      ["calendar-week", true],
      ["calendar-sources", true],
    ]);
    expect(summarize(results)).toEqual({ ok: true, message: "all 5 checks passed" });
  });

  it("allows an empty meal week but not an empty calendar week", async () => {
    const results = await runChecks(
      sky({ meals: { categories: async () => [{ id: "3", name: "Dinner" }], sittings: async () => [] }, calendar: { events: async () => [], sources: async () => [{ id: "s", label: "x", kind: "feed" }] } }),
      input
    );
    expect(results.find((r) => r.id === "meals-week")?.ok).toBe(true);
    expect(results.find((r) => r.id === "calendar-week")).toEqual({ id: "calendar-week", ok: false, reason: "empty" });
  });

  it("fails a changed shape, a missing Dinner category and an empty profile list", async () => {
    const results = await runChecks(
      sky({
        profiles: { list: async () => [] },
        meals: { categories: async () => [{ id: "3", name: "Lunch" }], sittings: async () => [{ id: "5", dates: [] }] },
        calendar: { events: async () => [{ title: "no id" }], sources: async () => ({ not: "a list" }) },
      }),
      input
    );
    expect(results.map((r) => r.reason)).toEqual(["empty", "no-dinner", "shape", "shape", "shape"]);
  });

  it("reports an expired sign-in as one reason", async () => {
    const boom = async () => {
      throw new AuthenticationError("Not signed in. Run `skylight-mcp auth login`.");
    };
    const results = await runChecks(
      sky({ profiles: { list: boom }, meals: { categories: boom, sittings: boom }, calendar: { events: boom, sources: boom } }),
      input
    );
    expect(summarize(results)).toEqual({ ok: false, message: "FAILED: sign-in needed" });
  });

  it("never copies Skylight data or error text into the alert", async () => {
    const results = await runChecks(
      sky({ profiles: { list: failing("profiles") }, calendar: { events: failing("calendar"), sources: async () => [{ id: "s1", kind: "feed" }] } }),
      input
    );
    const { message } = summarize(results);
    expect(message).toBe("FAILED: profiles:error, calendar-week:error");
    expect(message).not.toMatch(/SECRET/);
    expect(JSON.stringify(results)).not.toMatch(/SECRET/);
  });
});
