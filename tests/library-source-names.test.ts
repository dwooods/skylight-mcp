/**
 * Names and the default flag for source calendars (library 1.29.0). The properties that matter:
 * no email address ever comes back as a name, two calendars never look the same, a calendar has the
 * same name in sources() and in the create preview, and the default flag is Skylight's own.
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

  it("numbers calendars that would look the same in ascending id order, and the first keeps the plain name", () => {
    const l = sourceLabels([cal("959688", "a@example.com"), cal("9090009", "b@example.com"), cal("959687", "c@example.com")]);
    expect(l.get("959687")).toBe("Google calendar");
    expect(l.get("959688")).toBe("Google calendar 2");
    expect(l.get("9090009")).toBe("Google calendar 3");
  });

  it("compares ids as numbers, not text: 9 comes before 10", () => {
    const l = sourceLabels([cal("10", "a@example.com"), cal("9", "b@example.com")]);
    expect([l.get("9"), l.get("10")]).toEqual(["Google calendar", "Google calendar 2"]);
  });

  it("gives the same names however the list is ordered", () => {
    const list = [cal("5", "a@example.com"), cal("2", "b@example.com"), cal("8", "c@example.com")];
    const a = sourceLabels(list);
    const b = sourceLabels([...list].reverse());
    for (const id of ["2", "5", "8"]) expect(a.get(id)).toBe(b.get(id));
  });

  it("counts each kind on its own, and a calendar with a real name does not take a number", () => {
    const l = sourceLabels([cal("1", "a@example.com"), cal("2", "Home"), cal("3", "b@example.com", "webcal"), cal("4", "c@example.com", "webcal"), cal("5", "d@example.com")]);
    expect([l.get("1"), l.get("2"), l.get("3"), l.get("4"), l.get("5")]).toEqual(["Google calendar", "Home", "Calendar", "Calendar 2", "Google calendar 2"]);
  });

  it("treats a missing or non-text label like an email label", () => {
    const l = sourceLabels([cal("1", undefined), cal("2", null), cal("3", 7)]);
    expect([l.get("1"), l.get("2"), l.get("3")]).toEqual(["Google calendar", "Google calendar 2", "Google calendar 3"]);
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
