import { mkdtemp, readFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CredentialStoreError,
  createFileCredentialStore,
  createKeychainCredentialStore,
  savePendingLogin,
  takePendingLogin,
  type KeychainRunner,
} from "../src/api/credential-store.js";
import type { StoredCredential } from "../src/api/oauth.js";

const credential: StoredCredential = {
  version: 1,
  type: "oauth",
  accessToken: "test-access-SECRET",
  refreshToken: "test-refresh-SECRET",
  fingerprint: "fp-1",
  expiresAt: 1_700_000_000_000,
};

/** In-memory stand-in for /usr/bin/security. */
function fakeKeychain(options: { failAdd?: boolean } = {}) {
  let key: string | null = null;
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  const runner: KeychainRunner = async (args, input) => {
    calls.push({ args, input });
    const op = args[0];
    if (op === "find-generic-password") {
      return key === null ? { code: 44, stdout: "", stderr: "" } : { code: 0, stdout: `${key}\n`, stderr: "" };
    }
    if (op === "add-generic-password") {
      if (options.failAdd) return { code: 1, stdout: "", stderr: "denied" };
      key = (input ?? "").split("\n")[0];
      return { code: 0, stdout: "", stderr: "" };
    }
    if (op === "delete-generic-password") {
      const had = key !== null;
      key = null;
      return { code: had ? 0 : 44, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unknown" };
  };
  return { runner, calls, hasKey: () => key !== null, dropKey: () => (key = null) };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "skylight-mcp-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("file credential store", () => {
  it("round-trips with 0600 file and 0700 directory permissions", async () => {
    const store = createFileCredentialStore({ directory: path.join(dir, "cfg") });
    expect(await store.read()).toBeNull();
    await store.write(credential);
    expect(await store.read()).toEqual(credential);
    expect((await stat(path.join(dir, "cfg", "credential.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(dir, "cfg"))).mode & 0o777).toBe(0o700);
    expect(await store.delete()).toBe(true);
    expect(await store.delete()).toBe(false);
  });

  it("leaves no temp files behind", async () => {
    const store = createFileCredentialStore({ directory: dir });
    await store.write(credential);
    await store.write({ ...credential, accessToken: "test-access-2" });
    expect(await readdir(dir)).toEqual(["credential.json"]);
  });

  it("reports corruption instead of returning garbage", async () => {
    const store = createFileCredentialStore({ directory: dir });
    await store.write(credential);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "credential.json"), "{nope");
    await expect(store.read()).rejects.toThrow(CredentialStoreError);
  });
});

describe("keychain credential store", () => {
  it("round-trips and never writes tokens in plaintext", async () => {
    const kc = fakeKeychain();
    const store = createKeychainCredentialStore({ directory: dir, runner: kc.runner });
    await store.write(credential);
    const onDisk = await readFile(path.join(dir, "credential.enc.json"), "utf8");
    expect(onDisk).not.toContain("SECRET");
    expect(onDisk).not.toContain("test-access");
    expect(await store.read()).toEqual(credential);
    expect((await stat(path.join(dir, "credential.enc.json"))).mode & 0o777).toBe(0o600);
  });

  it("passes the key on stdin, not in argv", async () => {
    const kc = fakeKeychain();
    await createKeychainCredentialStore({ directory: dir, runner: kc.runner }).write(credential);
    const add = kc.calls.find((c) => c.args[0] === "add-generic-password")!;
    const key = add.input!.split("\n")[0];
    expect(key.length).toBeGreaterThan(20);
    expect(add.args.join(" ")).not.toContain(key);
    expect(add.args.at(-1)).toBe("-w");
  });

  it("reuses the same key across writes", async () => {
    const kc = fakeKeychain();
    const store = createKeychainCredentialStore({ directory: dir, runner: kc.runner });
    await store.write(credential);
    await store.write({ ...credential, accessToken: "test-access-2" });
    expect(kc.calls.filter((c) => c.args[0] === "add-generic-password")).toHaveLength(1);
    expect((await store.read())?.accessToken).toBe("test-access-2");
  });

  it("fails closed when the keychain refuses the key: nothing is written", async () => {
    const kc = fakeKeychain({ failAdd: true });
    const store = createKeychainCredentialStore({ directory: dir, runner: kc.runner });
    await expect(store.write(credential)).rejects.toThrow(/Keychain/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("fails closed when the key is gone: no decrypt, no fallback", async () => {
    const kc = fakeKeychain();
    const store = createKeychainCredentialStore({ directory: dir, runner: kc.runner });
    await store.write(credential);
    kc.dropKey();
    await expect(store.read()).rejects.toThrow(/missing from macOS Keychain/);
  });

  it("detects tampered ciphertext", async () => {
    const kc = fakeKeychain();
    const store = createKeychainCredentialStore({ directory: dir, runner: kc.runner });
    await store.write(credential);
    const file = path.join(dir, "credential.enc.json");
    const payload = JSON.parse(await readFile(file, "utf8"));
    payload.ciphertext = Buffer.from("tampered-bytes-here").toString("base64");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify(payload));
    await expect(store.read()).rejects.toThrow(/could not be decrypted/);
  });

  it("delete removes file and key", async () => {
    const kc = fakeKeychain();
    const store = createKeychainCredentialStore({ directory: dir, runner: kc.runner });
    await store.write(credential);
    expect(await store.delete()).toBe(true);
    expect(kc.hasKey()).toBe(false);
    expect(await store.read()).toBeNull();
  });
});

describe("pending login file", () => {
  const pending = { state: "s", codeVerifier: "v", fingerprint: "f", createdAt: 1 };

  it("is single use and 0600", async () => {
    await savePendingLogin(pending, dir);
    expect((await stat(path.join(dir, "pending-login.json"))).mode & 0o777).toBe(0o600);
    expect(await takePendingLogin(dir)).toEqual(pending);
    expect(await takePendingLogin(dir)).toBeNull();
  });
});
