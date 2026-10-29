/**
 * HTML for the two-step hosted sign-in. No client-side JavaScript, no
 * external assets. Every client-controlled string goes through escape().
 */

import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const escape = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
  body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
  h1{font-size:1.4rem}label{display:block;margin:1rem 0 .25rem;font-weight:600}
  input,textarea{width:100%;box-sizing:border-box;font:inherit;padding:.5rem;border:1px solid #999;border-radius:4px}
  button{font:inherit;padding:.5rem 1.2rem;border-radius:4px;border:1px solid #333;background:#333;color:#fff;cursor:pointer;margin-right:.5rem}
  button.secondary{background:#fff;color:#333}.hint{color:#555;font-size:.9rem;margin:.25rem 0 0}
  .warn{background:#fff4e5;border:1px solid #f0c36d;padding:.75rem;border-radius:4px}
  code{background:#f2f2f2;padding:0 .25rem;border-radius:3px}ol li{margin:.5rem 0}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function consentPage(details: ConsentDescription, handle: string, defaults: { timezone: string }): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  return page(
    `Connect ${details.clientName} to Skylight`,
    `<h1>Allow <em>${name}</em> to use your Skylight calendar?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ""}
<p>It will be able to read the calendar, chores, lists, tasks, meals and rewards, and to create or edit them. It cannot delete anything or upload photos.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label for="passphrase">Setup passphrase</label>
  <input id="passphrase" name="passphrase" type="password" autocomplete="off" required>
  <p class="hint">Set by whoever deployed this server.</p>
  <label for="frameId">Skylight frame ID</label>
  <input id="frameId" name="frameId" inputmode="numeric" pattern="[A-Za-z0-9_-]{1,64}" required>
  <p class="hint">After you sign in at ourskylight.com the address bar shows <code>/my-skylight/&lt;number&gt;</code>. That number.</p>
  <label for="timezone">Timezone</label>
  <input id="timezone" name="timezone" value="${escape(defaults.timezone)}" required>
  <p class="hint">IANA name, e.g. <code>America/Los_Angeles</code>. Used to interpret dates like "Friday".</p>
  <p><button name="decision" value="approve">Continue to Skylight sign-in</button>
  <button class="secondary" name="decision" value="deny">Deny</button></p>
</form>`
  );
}

export function pastePage(loginUrl: string, state: string): string {
  return page(
    "Sign in to Skylight",
    `<h1>Sign in to Skylight</h1>
<ol>
  <li><a href="${escape(loginUrl)}" target="_blank" rel="noopener">Open the Skylight sign-in page</a> and sign in. Your password goes to Skylight only; this server never sees it.</li>
  <li>Skylight bounces your browser through <code>https://ourskylight.com/welcome?code=…</code> and on to its home page too fast to copy. Get that address from your browser history: <kbd>Cmd-Y</kbd> (Mac) or <kbd>Ctrl-H</kbd>, search <code>welcome?code</code>, right-click the newest <em>Skylight</em> result, <em>Copy link address</em>.</li>
  <li>Paste it here. It must be from the sign-in you just did; an older one will be rejected.</li>
</ol>
<form method="post" action="/callback">
  <input type="hidden" name="state" value="${escape(state)}">
  <label for="url">Redirect URL from Skylight</label>
  <textarea id="url" name="url" rows="3" required placeholder="https://ourskylight.com/welcome?code=...&state=..."></textarea>
  <p class="hint">You have 10 minutes from opening this page.</p>
  <p><button>Finish connecting</button></p>
</form>`
  );
}

export function errorPage(message: string, status = 400): Response {
  return new Response(page("Something went wrong", `<h1>Something went wrong</h1><p>${escape(message)}</p><p><a href="javascript:history.back()">Go back</a></p>`), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function html(body: string, headers: Headers = new Headers(), status = 200): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  return new Response(body, { status, headers });
}

export function landingPage(): Response {
  return html(
    page(
      "Skylight MCP",
      `<h1>Skylight MCP</h1><p>A remote MCP server for a Skylight Calendar. Add <code>${"/mcp"}</code> on this host as a custom connector in Claude; it will walk you through signing in.</p>`
    )
  );
}
