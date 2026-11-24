/**
 * Names and the default flag for source calendars (library 1.29.0). The properties that matter:
 * by default no email address comes back as a name, nothing is numbered, "as-is" is opt-in and returns the
 * label only, a calendar has the same name in sources() and in the create preview, and the default flag is
 * Skylight's own.
 */
import { describe, expect, it } from "vitest";
import { sourceIsDefault, sourceLabels } from "../src/lib-writes.js";
import type { SourceCalendarResource } from "../src/api/types.js";

const cal = (id: string, label: unknown, kind = "gmail", extra: Record<string, unknown> = {}): SourceCalendarResource =>
  ({ id, type: "source_calendar", attributes: { label, kind, ...extra } }) as unknown as SourceCalendarResource;
const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/;

describe("sourceLabels", () => {
  it("returns a label that is not an email exactly as Skylight has it", () => {
    const l = sourceLabels([cal("1", "Family"), cal("2", "Woods Calendar")]);
    expect([l.get("1"), l.get("2")]).toEqual(["Family", "Woods Calendar"]);
  });

  it("never returns an email address, whatever the order of the list", () => {
    const list = [cal("30", "c.three@example.com"), cal("4", "a.one@example.com"), cal("11", "b.two@example.com", "webcal"), cal("12", "")];
    for (const l of [sourceLabels(list), sourceLabels([...list].reverse())]) {
      for (const v of l.values()) expect(v).not.toMatch(EMAIL);
    }
  });

  it("never numbers: calendars that share the placeholder keep the same plain name, whatever the order", () => {
    const list = [cal("959688", "a@example.com"), cal("9090009", "b@example.com"), cal("959687", "c@example.com")];
    for (const l of [sourceLabels(list), sourceLabels([...list].reverse())]) {
      expect([...l.values()]).toEqual(["Google calendar", "Google calendar", "Google calendar"]);
    }
  });

  it("uses the kind's placeholder, and a calendar with a real name keeps it", () => {
    const l = sourceLabels([cal("1", "a@example.com"), cal("2", "Home"), cal("3", "b@example.com", "webcal"), cal("4", "c@example.com", "other")]);
    expect([l.get("1"), l.get("2"), l.get("3"), l.get("4")]).toEqual(["Google calendar", "Home", "Calendar", "Calendar"]);
  });

  it("treats a missing or non-text label like an email label", () => {
    const l = sourceLabels([cal("1", undefined), cal("2", null), cal("3", 7)]);
    expect([...l.values()]).toEqual(["Google calendar", "Google calendar", "Google calendar"]);
  });

  it("as-is returns the label exactly as Skylight has it, an address included, and nothing else about the calendar", () => {
    const list = [cal("1", "her.name@example.com", "gmail", { source_id: "src.secret@group.calendar.example.com" }), cal("2", "Family"), cal("3", "", "gmail"), cal("4", undefined, "webcal")];
    const l = sourceLabels(list, true);
    expect([l.get("1"), l.get("2"), l.get("3"), l.get("4")]).toEqual(["her.name@example.com", "Family", "Google calendar", "Calendar"]);
    expect(JSON.stringify([...l.values()])).not.toContain("src.secret");
  });
});

describe("sourceIsDefault", () => {
  it("is true only when Skylight marks the calendar as the default for new events", () => {
    expect(sourceIsDefault(cal("1", "Family", "gmail", { default_for_new_events: true }))).toBe(true);
    expect(sourceIsDefault(cal("2", "Woods", "gmail", { default_for_new_events: false }))).toBe(false);
    expect(sourceIsDefault(cal("3", "Home", "webcal"))).toBe(false);
    expect(sourceIsDefault(cal("4", "X", "gmail", { default_for_new_events: "true" }))).toBe(false);
  });
});
