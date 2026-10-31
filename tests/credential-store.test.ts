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

// Windows ignores Unix permission bits (stat reports 0o666 / 0o777), so the mode checks
// only mean something on POSIX. The Windows file store is documented as unencrypted.
async function expectMode(target: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  expect((await stat(target)).mode & 0o777).toBe(mode);
}

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
    if (op === "-i") {
      // Interactive mode: one command per line on stdin; exit code is 0 even on failure.
      const m = /^add-generic-password -U -a (\S+) -s (\S+) -l (\S+) -w (\S+)$/.exec((input ?? "").trim());
      if (!m) return { code: 1, stdout: "", stderr: "bad command" };
      if (!options.failAdd) key = m[4];
      return { code: 0, stdout: "", stderr: options.failAdd ? "denied" : "" };
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
    await expectMode(path.join(dir, "cfg", "credential.json"), 0o600);
    await expectMode(path.join(dir, "cfg"), 0o700);
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
    await expectMode(path.join(dir, "credential.enc.json"), 0o600);
  });

  it("passes the key on stdin, not in argv", async () => {
    const kc = fakeKeychain();
    await createKeychainCredentialStore({ directory: dir, runner: kc.runner }).write(credential);
    const add = kc.calls.find((c) => c.args[0] === "-i")!;
    const key = / -w (\S+)/.exec(add.input!)![1];
    expect(key.length).toBeGreaterThan(20);
    expect(add.args).toEqual(["-i"]);
  });

  it("reuses the same key across writes", async () => {
    const kc = fakeKeychain();
    const store = createKeychainCredentialStore({ directory: dir, runner: kc.runner });
    await store.write(credential);
    await store.write({ ...credential, accessToken: "test-access-2" });
    expect(kc.calls.filter((c) => c.args[0] === "-i")).toHaveLength(1);
    expect((await store.read())?.accessToken).toBe("test-access-2");
  });

  it("fails closed when the keychain refuses the key: nothing is written", async () => {
    const kc = fakeKeychain({ failAdd: true });
    const store = createKeychainCredentialStore({ directory: dir, runner: kc.runner });
    await expect(store.write(credential)).rejects.toThrow(/did not store the encryption key/);
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
    await expectMode(path.join(dir, "pending-login.json"), 0o600);
    expect(await takePendingLogin(dir)).toEqual(pending);
    expect(await takePendingLogin(dir)).toBeNull();
  });
});

describe("defaultConfigDirectory per platform", () => {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  const env = { ...process.env };
  afterEach(() => {
    Object.defineProperty(process, "platform", real);
    process.env = { ...env };
  });

  it("uses %APPDATA% on Windows, not ~/.config", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.APPDATA = "C:\\Users\\someone\\AppData\\Roaming";
    const { defaultConfigDirectory } = await import("../src/api/credential-store.js");
    const dir = defaultConfigDirectory();
    expect(dir).toContain("skylight-mcp");
    expect(dir).toContain("AppData");
    expect(dir).not.toContain(".config");
  });

  it("keeps XDG on Linux", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.XDG_CONFIG_HOME = "/home/x/cfg";
    const { defaultConfigDirectory } = await import("../src/api/credential-store.js");
    expect(defaultConfigDirectory()).toContain("cfg");
  });
});
