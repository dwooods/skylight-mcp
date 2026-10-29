/**
 * Credential store contract. Kept free of Node-only imports so the Skylight
 * client can be bundled for runtimes without a filesystem (Cloudflare Workers).
 */

import type { StoredCredential } from "./oauth.js";

export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

export interface CredentialStore {
  readonly name: string;
  read(): Promise<StoredCredential | null>;
  write(credential: StoredCredential): Promise<void>;
  delete(): Promise<boolean>;
}
