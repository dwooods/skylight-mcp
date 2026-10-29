/**
 * Per-request context for runtimes that serve many users from one process.
 *
 * The local stdio server has one user, so `getClient()` / `getConfig()` fall
 * back to process-wide singletons. A hosted server wraps each request in
 * `runWithContext()` so the same endpoint and tool code resolves the
 * credential and settings for *that* request.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { SkylightClient } from "./api/client.js";
import type { Config } from "./config.js";

export interface RequestContext {
  client: SkylightClient;
  config: Config;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}
