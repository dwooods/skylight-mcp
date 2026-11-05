import { expect, it } from "vitest";
import { SKYLIGHT_API_VERSION } from "../../src/api/constants.js";
import { liveSuite } from "./harness.js";
import { diffShapes, isSameShape } from "./shape.js";

// Does the response shape of each read endpoint change between our default
// Skylight-Api-Version and the version the iOS app 2.31.0 sends? Skylight changes
// shapes silently under a different version (see the findings doc), so a gap here is a
// risk for every read tool that still sends the default.
//
// Read-only. The report holds key paths and types only, never values or ids
// (tests/shape.test.ts proves the fingerprint cannot print a value).

/** The version the iOS app 2.31.0 sends, captured 2026-11-04. */
const APP_VERSION = "2026-10-15";

interface Probe {
  name: string;
  endpoint: string;
  params?: Record<string, string | boolean | number | undefined>;
  plusOnly?: boolean;
}

liveSuite("api version: response shape", { tags: ["read", "contract"] }, (ctx) => {
  const from = ctx.today();
  const to = ctx.daysFromToday(35);
  const probes: Probe[] = [
    { name: "frame", endpoint: "/api/frames/{frameId}" },
    { name: "devices", endpoint: "/api/frames/{frameId}/devices" },
    { name: "avatars", endpoint: "/api/avatars" },
    { name: "colors", endpoint: "/api/colors" },
    { name: "categories", endpoint: "/api/frames/{frameId}/categories" },
    { name: "source_calendars", endpoint: "/api/frames/{frameId}/source_calendars" },
    {
      name: "calendar_events",
      endpoint: "/api/frames/{frameId}/calendar_events",
      params: { date_min: from, date_max: to, timezone: ctx.timezone, include: "categories" },
    },
    { name: "chores", endpoint: "/api/frames/{frameId}/chores", params: { after: from, before: to } },
    { name: "lists", endpoint: "/api/frames/{frameId}/lists" },
    { name: "task_box", endpoint: "/api/frames/{frameId}/task_box/items" },
    { name: "nudges", endpoint: "/api/frames/{frameId}/nudges" },
    { name: "meal_categories", endpoint: "/api/frames/{frameId}/meals/categories", plusOnly: true },
    {
      name: "meal_sittings",
      endpoint: "/api/frames/{frameId}/meals/sittings",
      params: { date_min: from, date_max: to },
      plusOnly: true,
    },
    { name: "recipes", endpoint: "/api/frames/{frameId}/meals/recipes", plusOnly: true },
    { name: "rewards", endpoint: "/api/frames/{frameId}/rewards", plusOnly: true },
    { name: "reward_points", endpoint: "/api/frames/{frameId}/reward_points", plusOnly: true },
  ];

  it(`default ${SKYLIGHT_API_VERSION} vs app ${APP_VERSION}`, async () => {
    expect(APP_VERSION).not.toBe(SKYLIGHT_API_VERSION);
    const client = ctx.client();
    const problems: string[] = [];
    const same: string[] = [];

    for (const probe of probes) {
      if (probe.plusOnly && !ctx.hasPlus) {
        ctx.note(`${probe.name} skipped: account has no Plus`);
        continue;
      }
      const fetchUnder = async (apiVersion: string): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> => {
        try {
          const body = await client.request<unknown>(probe.endpoint, { method: "GET", params: probe.params, apiVersion });
          return { ok: true, body };
        } catch (e) {
          // Status only: an error body can echo request details.
          const status = (e as { statusCode?: number }).statusCode;
          return { ok: false, error: `HTTP ${status ?? "error"}` };
        }
      };
      const oldRes = await fetchUnder(SKYLIGHT_API_VERSION);
      const newRes = await fetchUnder(APP_VERSION);

      if (!oldRes.ok || !newRes.ok) {
        const o = oldRes.ok ? "ok" : oldRes.error;
        const n = newRes.ok ? "ok" : newRes.error;
        // Failing under both is a broken probe, not a version finding; one-sided is the finding.
        problems.push(`${probe.name}: ${SKYLIGHT_API_VERSION} -> ${o}; ${APP_VERSION} -> ${n}`);
        continue;
      }
      const diff = diffShapes(oldRes.body, newRes.body);
      if (isSameShape(diff)) {
        same.push(probe.name);
      } else {
        problems.push(
          `${probe.name}: only under ${SKYLIGHT_API_VERSION}: [${diff.onlyOld.join(", ") || "none"}]; only under ${APP_VERSION}: [${diff.onlyNew.join(", ") || "none"}]`,
        );
      }
    }

    ctx.note(`same shape under both versions: ${same.join(", ") || "none"}`);
    // The report is the result. A non-empty list fails the test so the difference cannot be missed.
    expect(problems, `shape differences between versions:\n${problems.join("\n")}`).toEqual([]);
  });
});
