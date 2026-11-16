// Preloaded into the importer's child process: replaces fetch, records every call, serves fixtures.
// Fixtures are keyed by path suffix ("/calendar_events"), or by method and suffix ("POST /calendar_events"),
// which wins over the plain key for that method. A fixture with a numeric `__status` is served with that
// status. `{ __sequence: [a, b, ...] }` serves a, then b, ... (the last one repeats). `{ __throw: true }`
// makes fetch reject, as a network failure does.
import fs from "node:fs";
const fx = JSON.parse(fs.readFileSync(process.env.LIB_FIXTURES, "utf8"));
const calls = [];
const served = new Map();
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const method = init?.method ?? "GET";
  const auth = new Headers(init?.headers).get("authorization");
  calls.push({ url: String(url), host: u.host, auth, method, body: init?.body === undefined || init?.body === null ? null : String(init.body) });
  fs.writeFileSync(process.env.LIB_CALLS, JSON.stringify(calls));
  let key = null;
  for (const suffix of Object.keys(fx)) if (!suffix.includes(" ") && u.pathname.endsWith(suffix)) key = suffix;
  for (const k of Object.keys(fx)) {
    const [m, suffix] = k.split(" ");
    if (suffix && m === method && u.pathname.endsWith(suffix)) key = k;
  }
  let body = key === null ? { data: [] } : fx[key];
  if (body && Array.isArray(body.__sequence)) {
    const n = served.get(key) ?? 0;
    served.set(key, n + 1);
    body = body.__sequence[Math.min(n, body.__sequence.length - 1)];
  }
  if (body && body.__throw === true) throw new TypeError("fetch failed");
  const status = typeof body?.__status === "number" ? body.__status : 200;
  return new Response(JSON.stringify(body), { status });
};
