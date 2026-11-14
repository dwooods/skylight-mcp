import { describe, expect, it, vi } from "vitest";
import { PingConfigError, parsePingUrl, sendPing } from "../src/canary/ping.js";
import { nextRunAt, parseClock } from "../src/canary/schedule.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const GOOD = `https://hc-ping.com/${UUID}`;

describe("ping address", () => {
  it("accepts only https hc-ping.com/<uuid>", () => {
    expect(parsePingUrl(GOOD).href).toBe(GOOD);
    for (const bad of [
      undefined,
      "",
      "not a url",
      `http://hc-ping.com/${UUID}`,
      `https://evil.example/${UUID}`,
      `https://hc-ping.com.evil.example/${UUID}`,
      `https://hc-ping.com:8443/${UUID}`,
      `https://user:pw@hc-ping.com/${UUID}`,
      `https://hc-ping.com/${UUID}?x=1`,
      `https://hc-ping.com/${UUID}#x`,
      "https://hc-ping.com/ping-key/slug",
      `https://hc-ping.com/${UUID}/fail`,
    ]) {
      expect(() => parsePingUrl(bad as string | undefined), String(bad)).toThrow(PingConfigError);
    }
  });
});

describe("sending a ping", () => {
  const ok = () => new Response("OK", { status: 200 });

  it("pass: POST to the address, one short line", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const r = await sendPing(parsePingUrl(GOOD), { ok: true, message: "all 5 checks passed" }, { fetchImpl });
    expect(r).toEqual({ sent: true, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GOOD);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("all 5 checks passed");
    expect(init.redirect).toBe("error");
  });

  it("failure goes to /fail", async () => {
    const fetchImpl = vi.fn(async () => ok());
    await sendPing(parsePingUrl(GOOD), { ok: false, message: "FAILED: calendar-week:empty" }, { fetchImpl });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(`${GOOD}/fail`);
  });

  it("carries no credential: only a content type, and a bounded body", async () => {
    const fetchImpl = vi.fn(async () => ok());
    await sendPing(parsePingUrl(GOOD), { ok: false, message: "x".repeat(5000) }, { fetchImpl });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(["Content-Type"]);
    expect((init.body as string).length).toBe(200);
  });

  it("retries a failure, then reports not sent", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 500 }));
    const r = await sendPing(parsePingUrl(GOOD), { ok: true, message: "m" }, { fetchImpl, retries: 2 });
    expect(r).toEqual({ sent: false, status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("survives a network error and a later success", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      if (n++ === 0) throw new Error("offline");
      return ok();
    });
    expect((await sendPing(parsePingUrl(GOOD), { ok: true, message: "m" }, { fetchImpl })).sent).toBe(true);
  });
});

describe("daily schedule", () => {
  it("parses clock times", () => {
    expect(parseClock("9:30")).toBe("09:30");
    for (const bad of ["25:00", "9:60", "noon", ""]) expect(() => parseClock(bad)).toThrow();
  });

  it("picks today if still ahead, else tomorrow, in the zone", () => {
    const tz = "America/Los_Angeles";
    const at = (iso: string) => Date.parse(iso);
    // 2037-03-03 08:00 PST = 16:00Z; run at 09:30 PST = 17:30Z same day.
    expect(nextRunAt(at("2037-03-03T16:00:00Z"), "09:30", tz)).toBe(at("2037-03-03T17:30:00Z"));
    // After it: next day.
    expect(nextRunAt(at("2037-03-03T18:00:00Z"), "09:30", tz)).toBe(at("2037-03-04T17:30:00Z"));
    // Exactly at the time: strictly after, so tomorrow.
    expect(nextRunAt(at("2037-03-03T17:30:00Z"), "09:30", tz)).toBe(at("2037-03-04T17:30:00Z"));
  });

  it("follows daylight saving", () => {
    const tz = "America/Los_Angeles";
    // 2037-03-08 is spring-forward Sunday: 09:30 is PDT (UTC-7) = 16:30Z.
    expect(nextRunAt(Date.parse("2037-03-08T10:00:00Z"), "09:30", tz)).toBe(Date.parse("2037-03-08T16:30:00Z"));
  });
});
