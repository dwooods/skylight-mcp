import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OAuthError,
  beginBrowserLogin,
  completeBrowserLogin,
  isExpired,
  parseCallbackUrl,
  parseStoredCredential,
  refreshCredential,
  type StoredCredential,
} from "../src/api/oauth.js";

const NOW = 1_700_000_000_000;

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function callback(state: string, extra = ""): string {
  return `https://ourskylight.com/welcome?code=test-code-1&state=${state}${extra}`;
}

describe("beginBrowserLogin", () => {
  it("builds an S256 PKCE authorize URL bound to a random state", () => {
    const { loginUrl, pending } = beginBrowserLogin(NOW);
    const url = new URL(loginUrl);
    expect(url.origin).toBe("https://app.ourskylight.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("skylight-mobile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(pending.state);
    expect(url.searchParams.get("code_challenge")).not.toBe(pending.codeVerifier);
    expect(pending.createdAt).toBe(NOW);
  });

  it("generates fresh values each time", () => {
    expect(beginBrowserLogin().pending.state).not.toBe(beginBrowserLogin().pending.state);
  });
});

describe("parseCallbackUrl", () => {
  const { pending } = beginBrowserLogin(NOW);

  it("returns the code for a valid callback", () => {
    expect(parseCallbackUrl(callback(pending.state), pending, NOW + 1000)).toBe("test-code-1");
  });

  it("rejects a state mismatch", () => {
    expect(() => parseCallbackUrl(callback("wrong"), pending, NOW)).toThrow(/State mismatch/);
  });

  it("rejects a wrong host, path, or scheme", () => {
    for (const bad of [
      `https://evil.example/welcome?code=x&state=${pending.state}`,
      `https://ourskylight.com/other?code=x&state=${pending.state}`,
      `http://ourskylight.com/welcome?code=x&state=${pending.state}`,
    ]) {
      expect(() => parseCallbackUrl(bad, pending, NOW)).toThrow(OAuthError);
    }
  });

  it("rejects an error response, a missing code, and junk", () => {
    expect(() => parseCallbackUrl("https://ourskylight.com/welcome?error=access_denied", pending, NOW)).toThrow(/error/);
    expect(() => parseCallbackUrl(`https://ourskylight.com/welcome?state=${pending.state}`, pending, NOW)).toThrow(/code and state/);
    expect(() => parseCallbackUrl("not a url", pending, NOW)).toThrow(/complete URL/);
  });

  it("rejects an expired login", () => {
    expect(() => parseCallbackUrl(callback(pending.state), pending, NOW + 11 * 60 * 1000)).toThrow(/expired/);
  });
});

describe("token requests", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exchanges the code with the PKCE verifier and stores the result", async () => {
    const { pending } = beginBrowserLogin(NOW);
    const fetchMock = vi.fn(async () =>
      tokenResponse({ access_token: "test-access-1", refresh_token: "test-refresh-1", expires_in: 7200 })
    );
    const credential = await completeBrowserLogin(callback(pending.state), pending, fetchMock as unknown as typeof fetch, NOW);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.ourskylight.com/oauth/token");
    const body = init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("test-code-1");
    expect(body.get("code_verifier")).toBe(pending.codeVerifier);
    expect(credential).toMatchObject({
      version: 1,
      type: "oauth",
      accessToken: "test-access-1",
      refreshToken: "test-refresh-1",
      fingerprint: pending.fingerprint,
      expiresAt: NOW + 7_200_000,
    });
  });

  it("does not call the network when the state is wrong", async () => {
    const { pending } = beginBrowserLogin(NOW);
    const fetchMock = vi.fn();
    await expect(completeBrowserLogin(callback("wrong"), pending, fetchMock as unknown as typeof fetch, NOW)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects responses without a refresh token", async () => {
    const { pending } = beginBrowserLogin(NOW);
    const fetchMock = vi.fn(async () => tokenResponse({ access_token: "test-access-1" }));
    await expect(
      completeBrowserLogin(callback(pending.state), pending, fetchMock as unknown as typeof fetch, NOW)
    ).rejects.toThrow(/refresh token/);
  });

  it("surfaces HTTP errors with a truncated body", async () => {
    const { pending } = beginBrowserLogin(NOW);
    const fetchMock = vi.fn(async () => new Response("x".repeat(1000), { status: 400 }));
    const error = await completeBrowserLogin(callback(pending.state), pending, fetchMock as unknown as typeof fetch, NOW).catch(
      (e: Error) => e
    );
    expect((error as Error).message).toMatch(/HTTP 400/);
    expect((error as Error).message.length).toBeLessThan(300);
  });

  it("refreshes with the stored refresh token and keeps the fingerprint", async () => {
    const current: StoredCredential = {
      version: 1,
      type: "oauth",
      accessToken: "test-access-old",
      refreshToken: "test-refresh-old",
      fingerprint: "fp-1",
      expiresAt: NOW - 1,
    };
    const fetchMock = vi.fn(async () => tokenResponse({ access_token: "test-access-new", refresh_token: "test-refresh-new" }));
    const next = await refreshCredential(current, fetchMock as unknown as typeof fetch, NOW);
    const body = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("test-refresh-old");
    expect(next.refreshToken).toBe("test-refresh-new");
    expect(next.fingerprint).toBe("fp-1");
    expect(next.expiresAt).toBe(NOW + 3_600_000);
  });
});

describe("isExpired / parseStoredCredential", () => {
  const base: StoredCredential = {
    version: 1,
    type: "oauth",
    accessToken: "test-access-1",
    refreshToken: "test-refresh-1",
    fingerprint: "fp",
    expiresAt: NOW + 120_000,
  };

  it("treats tokens within the skew window as expired", () => {
    expect(isExpired(base, NOW)).toBe(false);
    expect(isExpired(base, NOW + 90_000)).toBe(true);
  });

  it("validates stored shapes", () => {
    expect(parseStoredCredential(base)).toEqual(base);
    expect(parseStoredCredential({ ...base, version: 2 })).toBeNull();
    expect(parseStoredCredential(null)).toBeNull();
    expect(parseStoredCredential({ ...base, expiresAt: "soon" })).toBeNull();
  });
});
