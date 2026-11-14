/**
 * The alert channel: a healthchecks.io ping. A pass is a plain ping; a failure is a POST to
 * `/fail` with one short line. A missed ping is the service's own alert, which covers the
 * canary not running at all.
 *
 * The ping address is a secret (anyone holding it can fake a pass). It comes from the
 * environment, is never logged, and may only point at hc-ping.com over https. This module
 * never sees a Skylight credential: it takes a URL and a message and nothing else, so the
 * bearer token cannot be sent to the ping host by this path.
 */

const PING_HOST = "hc-ping.com";
const UUID_PATH = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE = 200;

export class PingConfigError extends Error {}

export function parsePingUrl(raw: string | undefined): URL {
  if (!raw) throw new PingConfigError("CANARY_PING_URL is not set.");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PingConfigError("CANARY_PING_URL is not a valid URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== PING_HOST || url.port !== "") {
    throw new PingConfigError(`CANARY_PING_URL must be an https://${PING_HOST}/ address.`);
  }
  if (url.username || url.password || url.search || url.hash || !UUID_PATH.test(url.pathname)) {
    throw new PingConfigError("CANARY_PING_URL must be https://hc-ping.com/<check uuid>, with nothing else.");
  }
  return url;
}

export interface Outcome {
  ok: boolean;
  message: string;
}

export async function sendPing(
  base: URL,
  outcome: Outcome,
  options: { fetchImpl?: typeof fetch; retries?: number; timeoutMs?: number } = {}
): Promise<{ sent: boolean; status: number | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = (options.retries ?? 2) + 1;
  const target = new URL(base.href);
  if (!outcome.ok) target.pathname = `${target.pathname}/fail`;
  const body = outcome.message.slice(0, MAX_MESSAGE);

  let status: number | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetchImpl(target.href, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      status = response.status;
      if (response.ok) return { sent: true, status };
    } catch {
      status = null;
    }
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
  }
  return { sent: false, status };
}
