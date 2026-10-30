import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs helper without types
import { parseKvId, parseWorkerUrl, passphraseProblem, patchKvId } from "../scripts/setup-worker-lib.mjs";

const ID = "0123456789abcdef0123456789abcdef";

describe("worker setup helpers", () => {
  it("reads the KV id from wrangler's JSON snippet and from the TOML form", () => {
    expect(parseKvId(`✨ Success!\n{\n  "kv_namespaces": [\n    {\n      "binding": "OAUTH_KV",\n      "id": "${ID}"\n    }\n  ]\n}`)).toBe(ID);
    expect(parseKvId(`[[kv_namespaces]]\nbinding = "OAUTH_KV"\nid = "${ID}"`)).toBe(ID);
    expect(parseKvId("nothing useful here")).toBeNull();
  });

  it("reads the workers.dev origin without a path", () => {
    expect(parseWorkerUrl("Deployed skylight-mcp triggers\n  https://skylight-mcp.someone.workers.dev\nCurrent Version ID: x")).toBe("https://skylight-mcp.someone.workers.dev");
    expect(parseWorkerUrl("no url")).toBeNull();
  });

  it("patches only the placeholder and refuses anything else", () => {
    const config = '{ "binding": "OAUTH_KV", "id": "REPLACE_WITH_KV_NAMESPACE_ID" }';
    expect(patchKvId(config, ID)).toContain(ID);
    expect(patchKvId(config, ID)).not.toContain("REPLACE_WITH");
    expect(() => patchKvId(config, "short")).toThrow(/32 hex/);
    expect(() => patchKvId(patchKvId(config, ID), ID)).toThrow(/placeholder/);
  });

  it("enforces the 12-character passphrase the consent page needs", () => {
    expect(passphraseProblem("short")).toBeTruthy();
    expect(passphraseProblem("long enough passphrase")).toBeNull();
    expect(passphraseProblem(" leading space here")).toBeTruthy();
  });
});
