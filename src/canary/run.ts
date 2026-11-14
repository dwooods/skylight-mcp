#!/usr/bin/env node
/**
 * Breakage canary. Runs read-only checks through the library entry, prints one line, and exits
 * 0 on a pass or 1 on a failure (including an expired sign-in). It does not schedule itself and
 * sends nothing: run it from the host's scheduler and let the scheduler email you on a non-zero
 * exit (on a Synology NAS, a Task Scheduler user-defined script with "send run details by email
 * only when the script terminates abnormally"). See canary/README.md.
 *
 * Settings come from the environment:
 *   SKYLIGHT_FRAME_ID   digits (required)
 *   SKYLIGHT_TIMEZONE   IANA zone (required)
 *   CANARY_DINNER_NAME  meal category that must exist, default Dinner
 * The sign-in is the CLI's own (`skylight-mcp auth login`), stored in XDG_CONFIG_HOME.
 *
 *   node dist/canary/run.js --once
 */

import { pathToFileURL } from "node:url";
import { defaultCredentialStore } from "../api/credential-store.js";
import { createSkylight, type Skylight } from "../lib.js";
import { addDays, dateInZone } from "../utils/schedule.js";
import { runChecks, summarize } from "./checks.js";

export interface CycleDeps {
  skylight: Skylight;
  timezone: string;
  dinnerName: string;
  now: () => number;
  log: (line: string) => void;
}

/** One cycle: checks, then one log line. Never logs anything Skylight returned (the message is a fixed vocabulary). */
export async function runCycle(deps: CycleDeps): Promise<{ ok: boolean; message: string }> {
  const today = dateInZone(deps.now(), deps.timezone);
  const results = await runChecks(deps.skylight, { from: today, to: addDays(today, 6), dinnerName: deps.dinnerName });
  const verdict = summarize(results);
  deps.log(`[canary] ${today} ${verdict.ok ? "PASS" : "FAIL"}: ${verdict.message}`);
  return verdict;
}

async function main(): Promise<void> {
  const env = process.env;
  const timezone = env.SKYLIGHT_TIMEZONE ?? "";
  const skylight = createSkylight({
    frameId: env.SKYLIGHT_FRAME_ID ?? "",
    timezone,
    credential: defaultCredentialStore(),
  });
  const result = await runCycle({
    skylight,
    timezone,
    dinnerName: env.CANARY_DINNER_NAME ?? "Dinner",
    now: () => Date.now(),
    log: (line) => console.log(line),
  });
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Configuration errors only (bad env). Print the message, never the environment.
    console.error(`[canary] cannot start: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 78;
  });
}
