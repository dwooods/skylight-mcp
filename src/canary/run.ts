#!/usr/bin/env node
/**
 * Breakage canary, for a container that is always on. Once a day it runs read-only checks
 * through the library entry and pings healthchecks.io: a pass is a plain ping, a failure is
 * a /fail ping with one short line, and a missed ping is the service's own alert.
 *
 * Settings come from the environment:
 *   SKYLIGHT_FRAME_ID   digits (required)
 *   SKYLIGHT_TIMEZONE   IANA zone (required)
 *   CANARY_PING_URL     https://hc-ping.com/<check uuid> (required; a secret)
 *   CANARY_TIME         HH:MM local time of the daily run, default 09:30
 *   CANARY_DINNER_NAME  meal category that must exist, default Dinner
 * The sign-in is the CLI's own (`skylight-mcp auth login`), stored in XDG_CONFIG_HOME.
 *
 *   node dist/canary/run.js --once   run one cycle now and exit (0 pass, 1 fail)
 *   node dist/canary/run.js          run now, then every day at CANARY_TIME
 */

import { pathToFileURL } from "node:url";
import { defaultCredentialStore } from "../api/credential-store.js";
import { createSkylight, type Skylight } from "../lib.js";
import { addDays, dateInZone } from "../utils/schedule.js";
import { runChecks, summarize } from "./checks.js";
import { parsePingUrl, sendPing } from "./ping.js";
import { nextRunAt, parseClock } from "./schedule.js";

export interface CycleDeps {
  skylight: Skylight;
  pingUrl: URL;
  timezone: string;
  dinnerName: string;
  now: () => number;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
}

/** One cycle: checks, then one ping. Never logs the ping address or anything Skylight returned. */
export async function runCycle(deps: CycleDeps): Promise<{ ok: boolean; message: string; pinged: boolean }> {
  const today = dateInZone(deps.now(), deps.timezone);
  const results = await runChecks(deps.skylight, { from: today, to: addDays(today, 6), dinnerName: deps.dinnerName });
  const verdict = summarize(results);
  const ping = await sendPing(deps.pingUrl, verdict, { fetchImpl: deps.fetchImpl });
  deps.log(
    `[canary] ${today} ${verdict.ok ? "PASS" : "FAIL"}: ${verdict.message}; ping ${ping.sent ? `sent (${ping.status})` : "NOT sent"}`
  );
  return { ...verdict, pinged: ping.sent };
}

async function main(): Promise<void> {
  const env = process.env;
  const timezone = env.SKYLIGHT_TIMEZONE ?? "";
  const clock = parseClock(env.CANARY_TIME ?? "09:30");
  const pingUrl = parsePingUrl(env.CANARY_PING_URL);
  const skylight = createSkylight({
    frameId: env.SKYLIGHT_FRAME_ID ?? "",
    timezone,
    credential: defaultCredentialStore(),
  });
  const deps: CycleDeps = {
    skylight,
    pingUrl,
    timezone,
    dinnerName: env.CANARY_DINNER_NAME ?? "Dinner",
    now: () => Date.now(),
    log: (line) => console.log(line),
  };

  if (process.argv.includes("--once")) {
    const result = await runCycle(deps);
    process.exitCode = result.ok && result.pinged ? 0 : 1;
    return;
  }

  // Loop forever. A cycle never throws (checks catch their own errors), but guard anyway.
  for (;;) {
    try {
      await runCycle(deps);
    } catch {
      deps.log("[canary] cycle crashed");
    }
    const at = nextRunAt(Date.now(), clock, timezone);
    deps.log(`[canary] next run in ${Math.round((at - Date.now()) / 60_000)} minutes`);
    await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, at - Date.now())));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Configuration errors only (bad env). Print the message, never the environment.
    console.error(`[canary] cannot start: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 78;
  });
}
