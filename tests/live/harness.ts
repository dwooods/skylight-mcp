/**
 * Live test harness: runs the real tool surface against a real Skylight frame.
 *
 * Safety properties (each has a test in tests/live-guard.test.ts or is
 * enforced here):
 * - Nothing runs unless SKYLIGHT_LIVE=1.
 * - Message tools are denied: a message cannot be deleted and shows on the
 *   family's wall display. Allowing them is a deliberate edit of DENIED_TOOLS.
 * - Photo tools are never registered.
 * - Credentials come from the normal sources (Keychain-backed store or env),
 *   are never printed, and nothing here writes them anywhere. If the store is
 *   unusable the run fails closed.
 * - Write tests create throwaway records prefixed LIVE_PREFIX and register a
 *   cleanup that runs even when an assertion fails.
 */

import { afterAll, beforeAll, describe } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../../src/config.js";
import { initializeClient, type SkylightClient } from "../../src/api/client.js";
import { defaultCredentialStore } from "../../src/api/credential-store.js";
import { registerTools } from "../../src/tools/registry.js";
import { addDays } from "../../src/utils/schedule.js";

/** Read at call time so tests can toggle it. */
export function liveEnabled(): boolean {
  return process.env.SKYLIGHT_LIVE === "1";
}
export const LIVE_PREFIX = "[live-test] ";

/** Tools the live suite may never call. */
export const DENIED_TOOLS: ReadonlySet<string> = new Set(["send_message", "update_message"]);

export function assertToolAllowed(name: string): void {
  if (DENIED_TOOLS.has(name)) {
    throw new Error(`Live tests may not call ${name}: it changes what the family sees and cannot be undone.`);
  }
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface LiveContext {
  /** Call a tool exactly as Claude would. Denied tools throw. */
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** The authenticated client, for raw contract checks. */
  client(): SkylightClient;
  readonly timezone: string;
  readonly hasPlus: boolean;
  /** Today's date in the frame's zone, YYYY-MM-DD. */
  today(): string;
  daysFromToday(n: number): string;
  /** Run after the suite, pass or fail, newest first. */
  onCleanup(fn: () => Promise<void>): void;
  /** Print a note in the test output, e.g. why an assertion was skipped. */
  note(message: string): void;
}

interface Connection {
  mcp: Client;
  server: McpServer;
  client: SkylightClient;
  timezone: string;
  hasPlus: boolean;
  cleanups: Array<() => Promise<void>>;
}

async function connect(): Promise<Connection> {
  if (!process.env.SKYLIGHT_FRAME_ID) {
    throw new Error("Set SKYLIGHT_FRAME_ID in your shell (not in a file in this repo) before running live tests.");
  }
  const config = loadConfig();
  const client = await initializeClient(config, defaultCredentialStore());
  const hasPlus = client.hasPlus();

  const server = new McpServer({ name: "skylight-live", version: "0.0.0" });
  registerTools(server, { hasPlus, photos: false });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "live-tests", version: "0.0.0" });
  await mcp.connect(clientSide);
  return { mcp, server, client, timezone: config.timezone, hasPlus, cleanups: [] };
}

export interface LiveSuiteOptions {
  /** e.g. ["read", "contract"] or ["write", "meals"]. Used by LIVE_TAGS / LIVE_SKIP_TAGS. */
  tags: string[];
}

function tagList(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

/** Whether a suite with these tags should run under the current environment. */
export function suiteEnabled(tags: string[]): boolean {
  if (!liveEnabled()) return false;
  const only = tagList("LIVE_TAGS");
  const skip = tagList("LIVE_SKIP_TAGS");
  if (only.length > 0 && !tags.some((t) => only.includes(t))) return false;
  if (tags.some((t) => skip.includes(t))) return false;
  return true;
}

/**
 * Declare one live suite. One suite per file is the convention: adding a
 * test is adding a file, removing one is deleting it.
 */
export function liveSuite(name: string, options: LiveSuiteOptions, body: (ctx: LiveContext) => void): void {
  let conn: Connection | undefined;
  const need = (): Connection => {
    if (!conn) throw new Error("Live connection is not ready.");
    return conn;
  };

  const ctx: LiveContext = {
    async call(toolName, args = {}) {
      assertToolAllowed(toolName);
      const result = (await need().mcp.callTool({ name: toolName, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
      return { text, isError: result.isError === true };
    },
    client: () => need().client,
    get timezone() {
      return need().timezone;
    },
    get hasPlus() {
      return need().hasPlus;
    },
    today: () => new Date().toLocaleDateString("en-CA", { timeZone: need().timezone }),
    daysFromToday: (n) => addDays(new Date().toLocaleDateString("en-CA", { timeZone: need().timezone }), n),
    onCleanup: (fn) => {
      need().cleanups.unshift(fn);
    },
    note: (message) => console.info(`[live] ${name}: ${message}`),
  };

  describe.skipIf(!suiteEnabled(options.tags))(`[live] ${name}`, () => {
    beforeAll(async () => {
      conn = await connect();
    });
    afterAll(async () => {
      if (!conn) return;
      for (const fn of conn.cleanups) {
        await fn().catch((error: unknown) =>
          console.error(`[live] cleanup failed in "${name}": ${error instanceof Error ? error.message : String(error)}`)
        );
      }
      await conn.mcp.close().catch(() => undefined);
      await conn.server.close().catch(() => undefined);
    });
    body(ctx);
  });
}

/** `sitting ID: 123` -> "123". */
export function sittingIdFrom(text: string): string | null {
  return /sitting ID: (\d+)/.exec(text)?.[1] ?? null;
}

/** `- Dinner (ID: 12)` -> "12". */
export function categoryIdFrom(text: string, name: string): string | null {
  return new RegExp(`${name} \\(ID: (\\d+)\\)`).exec(text)?.[1] ?? null;
}
