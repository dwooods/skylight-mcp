// Pure helpers for scripts/setup-worker.mjs, kept separate so they can be tested.

/** KV namespace id from `wrangler kv namespace create` output. */
export function parseKvId(output) {
  const m = output.match(/"id"\s*:\s*"([0-9a-f]{32})"/i) ?? output.match(/\bid\s*=\s*"([0-9a-f]{32})"/i);
  return m ? m[1] : null;
}

/** The workers.dev origin from `wrangler deploy` output (no path). */
export function parseWorkerUrl(output) {
  const m = output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  return m ? m[0] : null;
}

/** Put a real KV id in place of the placeholder. Throws if there is no placeholder to replace. */
export function patchKvId(config, id) {
  if (!/^[0-9a-f]{32}$/i.test(id)) throw new Error("KV id is not 32 hex characters");
  if (!config.includes("REPLACE_WITH_KV_NAMESPACE_ID")) throw new Error("No KV placeholder found in the config to replace");
  return config.replace("REPLACE_WITH_KV_NAMESPACE_ID", id);
}

/** Passphrase rules the Worker's consent page enforces: 12+ characters. */
export function passphraseProblem(p) {
  if (p.length < 12) return "Use at least 12 characters.";
  if (/^\s|\s$/.test(p)) return "Remove leading or trailing spaces.";
  return null;
}
