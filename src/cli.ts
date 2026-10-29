/**
 * `skylight-mcp auth ...` commands. These are CLI-only on purpose: credential
 * handling is never exposed as an MCP tool.
 *
 *   skylight-mcp auth login            print the sign-in URL
 *   skylight-mcp auth complete [url]   paste the final redirect URL to finish
 *   skylight-mcp auth status           show whether a credential is stored
 *   skylight-mcp auth logout           delete the stored credential
 */

import { createInterface } from "node:readline/promises";
import { defaultCredentialStore, savePendingLogin, takePendingLogin, type CredentialStore } from "./api/credential-store.js";
import {
  OAuthError,
  PENDING_LOGIN_TTL_MS,
  beginBrowserLogin,
  completeBrowserLogin,
  isExpired,
  refreshCredential,
  type PendingLogin,
  type StoredCredential,
} from "./api/oauth.js";

export interface CliDeps {
  store: CredentialStore;
  out: (line: string) => void;
  prompt: (question: string) => Promise<string>;
  savePending: (pending: PendingLogin) => Promise<void>;
  takePending: () => Promise<PendingLogin | null>;
  complete: (url: string, pending: PendingLogin) => Promise<StoredCredential>;
  refresh: (credential: StoredCredential) => Promise<StoredCredential>;
  now: () => number;
}

function defaultDeps(): CliDeps {
  return {
    store: defaultCredentialStore(),
    out: (line) => console.log(line),
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    savePending: (pending) => savePendingLogin(pending),
    takePending: () => takePendingLogin(),
    complete: (url, pending) => completeBrowserLogin(url, pending),
    refresh: (credential) => refreshCredential(credential),
    now: () => Date.now(),
  };
}

const USAGE = `Usage: skylight-mcp auth <command>

  login            Print a Skylight sign-in URL. Open it in your browser.
  complete [url]   After signing in, paste the final URL (https://ourskylight.com/welcome?...).
  status           Show whether you are signed in.
  logout           Remove the stored credential.`;

export async function runAuthCommand(args: readonly string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  const [command, ...rest] = args;

  try {
    switch (command) {
      case "login": {
        const { loginUrl, pending } = beginBrowserLogin(deps.now());
        await deps.savePending(pending);
        deps.out("1. Open this URL in your browser and sign in to Skylight:\n");
        deps.out(`   ${loginUrl}\n`);
        deps.out("2. After signing in, the browser lands on a page at https://ourskylight.com/welcome.");
        deps.out("   It may look blank or show an error. That is expected. Copy the full URL from the address bar.\n");
        deps.out("3. Run:  skylight-mcp auth complete");
        deps.out(`   and paste the URL. This login expires in ${PENDING_LOGIN_TTL_MS / 60_000} minutes.`);
        return 0;
      }

      case "complete": {
        const url = rest[0] ?? (await deps.prompt("Paste the full redirect URL: "));
        if (!url.trim()) {
          deps.out("No URL provided.");
          return 1;
        }
        const pending = await deps.takePending();
        if (!pending) {
          deps.out("No login in progress. Run `skylight-mcp auth login` first.");
          return 1;
        }
        const credential = await deps.complete(url, pending);
        await deps.store.write(credential);
        deps.out(`Signed in. Credential saved (${deps.store.name}).`);
        deps.out("Restart your MCP client to pick it up.");
        return 0;
      }

      case "status": {
        const credential = await deps.store.read();
        if (!credential) {
          deps.out("Not signed in. Run `skylight-mcp auth login`.");
          return 1;
        }
        const expiry = new Date(credential.expiresAt).toISOString();
        deps.out(`Signed in. Storage: ${deps.store.name}.`);
        deps.out(
          isExpired(credential, deps.now())
            ? `Access token expired at ${expiry}; it will refresh on next use.`
            : `Access token valid until ${expiry}.`
        );
        return 0;
      }

      case "logout": {
        const removed = await deps.store.delete();
        deps.out(removed ? "Signed out. Stored credential removed." : "Nothing to remove.");
        deps.out("Note: this does not revoke the session on Skylight's side.");
        return 0;
      }

      default:
        deps.out(USAGE);
        return command === undefined || command === "help" || command === "--help" ? 0 : 1;
    }
  } catch (error) {
    if (error instanceof OAuthError || error instanceof Error) {
      deps.out(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
