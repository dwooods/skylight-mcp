import { describe, expect, it } from "vitest";
import { SkylightClient, getClient } from "../src/api/client.js";
import { getConfig } from "../src/config.js";
import { runWithContext } from "../src/context.js";

describe("request context", () => {
  it("getClient/getConfig resolve per-request values inside runWithContext", async () => {
    const a = new SkylightClient({ frameId: "a", authType: "bearer", timezone: "UTC", token: "test-token-a" });
    const b = new SkylightClient({ frameId: "b", authType: "bearer", timezone: "Europe/Paris", token: "test-token-b" });
    const [fa, fb] = await Promise.all([
      runWithContext({ client: a, config: { frameId: "a", authType: "bearer", timezone: "UTC" } }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return [getClient().frameId, getConfig().timezone];
      }),
      runWithContext({ client: b, config: { frameId: "b", authType: "bearer", timezone: "Europe/Paris" } }, async () => [
        getClient().frameId,
        getConfig().timezone,
      ]),
    ]);
    expect(fa).toEqual(["a", "UTC"]);
    expect(fb).toEqual(["b", "Europe/Paris"]);
  });

  it("getClient throws outside a context when nothing was initialized", () => {
    expect(() => getClient()).toThrow(/not been initialized/);
  });
});
