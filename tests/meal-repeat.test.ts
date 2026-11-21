import { describe, expect, it } from "vitest";
import { buildRrule, expand, normalizeRepeat, occurrences, parseRrule, repeatNotices, sameRepeat, RepeatInputError } from "../src/utils/meal-repeat.js";

// The request rule the web app sent, the rule Skylight stored, and the instances it returned
// for March 2027 (captured 2026-11-20; window 03-01 to 04-01, end exclusive).
const CAPTURED = [
  {
    name: "A weekly Fri until 03-26",
    date: "2027-03-05",
    input: { every: "week", weekdays: ["FR"], until: "2027-03-26" },
    sent: "FREQ=WEEKLY;INTERVAL=1;UNTIL=20270326T235959Z;WKST=SU;BYDAY=FR",
    stored: "FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYDAY=FR;UNTIL=20270326",
    march: ["2027-03-05", "2027-03-12", "2027-03-19", "2027-03-26"],
  },
  {
    name: "B every 2 weeks Mon+Wed, no end",
    date: "2027-03-01",
    input: { every: "week", interval: 2, weekdays: ["WE", "MO"] },
    sent: "FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=MO,WE",
    stored: "FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=MO,WE",
    march: ["2027-03-01", "2027-03-03", "2027-03-15", "2027-03-17", "2027-03-29", "2027-03-31"],
  },
  {
    name: "C monthly on the 1st",
    date: "2027-03-01",
    input: { every: "month" },
    sent: "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
    stored: "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
    march: ["2027-03-01"],
  },
  {
    name: "C2 monthly on the 1st Monday",
    date: "2027-03-01",
    input: { every: "month", monthlyOn: "weekday" },
    sent: "FREQ=MONTHLY;INTERVAL=1;BYSETPOS=1;BYDAY=MO",
    stored: "FREQ=MONTHLY;INTERVAL=1;BYSETPOS=1;BYDAY=MO",
    march: ["2027-03-01"],
  },
  {
    name: "D1 daily until 03-03",
    date: "2027-03-01",
    input: { every: "day", until: "2027-03-03" },
    sent: "FREQ=DAILY;INTERVAL=1;UNTIL=20270303T235959Z",
    stored: "FREQ=DAILY;INTERVAL=1;UNTIL=20270303",
    march: ["2027-03-01", "2027-03-02", "2027-03-03"],
  },
  {
    name: "D2 yearly",
    date: "2027-03-01",
    input: { every: "year" },
    sent: "FREQ=YEARLY;INTERVAL=1",
    stored: "FREQ=YEARLY;INTERVAL=1",
    march: ["2027-03-01"],
  },
] as const;

describe("meal repeat rules against the 2026-11-20 captures", () => {
  for (const c of CAPTURED) {
    it(`${c.name}: builds what the app sent, reads what Skylight stored, expands to what it returned`, () => {
      const r = normalizeRepeat(c.input, c.date);
      expect(buildRrule(r, c.date)).toBe(c.sent);
      expect(parseRrule(c.stored)).toEqual(r);
      expect(parseRrule(c.sent)).toEqual(r);
      expect(sameRepeat(c.stored, r, c.date)).toBe(true);
      expect(expand(r, c.date, 100).filter((d) => d < "2027-04-01")).toEqual(c.march);
    });
  }

  it('"weekly" keeps its old rule exactly', () => {
    const r = normalizeRepeat("weekly", "2027-03-05");
    expect(buildRrule(r, "2027-03-05")).toBe("FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYDAY=FR");
  });

  it("the edited end date (captured) reads back as the new end", () => {
    const r = normalizeRepeat({ every: "week", weekdays: ["FR"], until: "2027-03-19" }, "2027-03-05");
    expect(buildRrule(r, "2027-03-05")).toBe("FREQ=WEEKLY;INTERVAL=1;UNTIL=20270319T235959Z;WKST=SU;BYDAY=FR");
    expect(sameRepeat("FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYDAY=FR;UNTIL=20270319", r, "2027-03-05")).toBe(true);
    expect(sameRepeat("FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYDAY=FR;UNTIL=20270326", r, "2027-03-05")).toBe(false);
  });
});

describe("refusals (all invalid_repeat in the library)", () => {
  const bad: Array<[string, unknown, string]> = [
    ["no every", {}, "2027-03-01"],
    ["unknown unit", { every: "hour" }, "2027-03-01"],
    ["interval 0", { every: "day", interval: 0 }, "2027-03-01"],
    ["interval 100", { every: "day", interval: 100 }, "2027-03-01"],
    ["interval 1.5", { every: "day", interval: 1.5 }, "2027-03-01"],
    ["weekdays on a month", { every: "month", weekdays: ["MO"] }, "2027-03-01"],
    ["monthly on a week", { every: "week", monthlyOn: "date" }, "2027-03-01"],
    ["empty weekdays", { every: "week", weekdays: [] }, "2027-03-01"],
    ["bad weekday", { every: "week", weekdays: ["MO", "XX"] }, "2027-03-01"],
    ["weekday twice", { every: "week", weekdays: ["MO", "MO"] }, "2027-03-01"],
    ["weekdays without the start day", { every: "week", weekdays: ["TU"] }, "2027-03-01"],
    ["until before date", { every: "day", until: "2027-02-28" }, "2027-03-01"],
    ["until not a date", { every: "day", until: "2027-02-30" }, "2027-03-01"],
    ["unknown field", { every: "day", count: 3 }, "2027-03-01"],
    ["a string other than weekly", "daily", "2027-03-01"],
  ];
  for (const [name, input, date] of bad) {
    it(name, () => {
      expect(() => normalizeRepeat(input, date)).toThrow(RepeatInputError);
    });
  }
  it("an until on the start day is allowed (one meal)", () => {
    const r = normalizeRepeat({ every: "day", until: "2027-03-01" }, "2027-03-01");
    expect(expand(r, "2027-03-01", 10)).toEqual(["2027-03-01"]);
  });
});

describe("reading rules the library does not model", () => {
  for (const rule of [
    "FREQ=WEEKLY;COUNT=4;BYDAY=MO",
    "FREQ=MONTHLY;BYMONTHDAY=1,15",
    "FREQ=YEARLY;BYMONTH=3",
    "FREQ=MONTHLY;BYDAY=-1FR",
    "FREQ=HOURLY;INTERVAL=1",
    "FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=MO",
    "FREQ=WEEKLY;INTERVAL=1",
    "garbage",
  ]) {
    it(`${rule} is { every: "other" }`, () => expect(parseRrule(rule)).toEqual({ every: "other" }));
  }
  it("no rule is null", () => expect(parseRrule(null)).toBeNull());
  it('an "other" rule never matches an asked rule', () => {
    expect(sameRepeat("FREQ=WEEKLY;COUNT=4;BYDAY=MO", normalizeRepeat({ every: "week" }, "2027-03-01"), "2027-03-01")).toBe(false);
  });
  it("a month rule on another day does not match", () => {
    const r = normalizeRepeat({ every: "month" }, "2027-03-01");
    expect(sameRepeat("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=2", r, "2027-03-01")).toBe(false);
    const n = normalizeRepeat({ every: "month", monthlyOn: "weekday" }, "2027-03-01");
    expect(sameRepeat("FREQ=MONTHLY;INTERVAL=1;BYSETPOS=2;BYDAY=MO", n, "2027-03-01")).toBe(false);
    expect(sameRepeat("FREQ=MONTHLY;INTERVAL=1;BYSETPOS=1;BYDAY=TU", n, "2027-03-01")).toBe(false);
  });
});

describe("occurrences and notices for the preview", () => {
  it("the first five, and the last one when the rule ends", () => {
    const r = normalizeRepeat({ every: "week", interval: 2, weekdays: ["MO", "WE"], until: "2027-12-20" }, "2027-03-01");
    const o = occurrences(r, "2027-03-01");
    expect(o.first).toEqual(["2027-03-01", "2027-03-03", "2027-03-15", "2027-03-17", "2027-03-29"]);
    expect(o.last).toBe("2027-12-20"); // Sun Dec 19 is 42 weeks after Sun Feb 28, an even week
  });
  it("no last date when open-ended", () => {
    expect(occurrences(normalizeRepeat({ every: "year" }, "2027-03-01"), "2027-03-01").last).toBeNull();
  });
  it("the 31st skips months without one, in the first year", () => {
    const r = normalizeRepeat({ every: "month" }, "2027-01-31");
    expect(repeatNotices(r, "2027-01-31")).toEqual([{ code: "skips_months", months: [2, 4, 6, 9, 11] }]);
    expect(expand(r, "2027-01-31", 4)).toEqual(["2027-01-31", "2027-03-31", "2027-05-31", "2027-07-31"]);
  });
  it("a 5th weekday skips months that lack one", () => {
    const r = normalizeRepeat({ every: "month", monthlyOn: "weekday" }, "2027-03-29"); // 5th Monday
    const n = repeatNotices(r, "2027-03-29");
    expect(n[0]?.code).toBe("skips_months");
    expect(n[0]?.months).toContain(4);
    expect(expand(r, "2027-03-29", 2)).toEqual(["2027-03-29", "2027-05-31"]);
  });
  it("Feb 29 yearly lands only in leap years", () => {
    expect(expand(normalizeRepeat({ every: "year" }, "2028-02-29"), "2028-02-29", 2)).toEqual(["2028-02-29", "2032-02-29"]);
  });
  it("no notice for an ordinary day of month or a week rule", () => {
    expect(repeatNotices(normalizeRepeat({ every: "month" }, "2027-03-01"), "2027-03-01")).toEqual([]);
    expect(repeatNotices(normalizeRepeat({ every: "week" }, "2027-03-01"), "2027-03-01")).toEqual([]);
  });
});
