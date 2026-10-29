import type { StoredCredential } from "../api/oauth.js";

/**
 * What the authorization server stores (encrypted) on each grant and hands to
 * the MCP handler on every request. One grant = one Claude connection = one
 * Skylight sign-in with its own device fingerprint and rotating refresh token.
 */
export interface SkylightProps {
  accessToken: string;
  refreshToken: string;
  fingerprint: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  frameId: string;
  timezone: string;
  hasPlus: boolean;
}

export function toCredential(props: SkylightProps): StoredCredential {
  return {
    version: 1,
    type: "oauth",
    accessToken: props.accessToken,
    refreshToken: props.refreshToken,
    fingerprint: props.fingerprint,
    expiresAt: props.expiresAt,
  };
}

export function withCredential(props: SkylightProps, credential: StoredCredential): SkylightProps {
  return {
    ...props,
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    fingerprint: credential.fingerprint,
    expiresAt: credential.expiresAt,
  };
}

/** Seconds the Claude-facing access token may live: expire before Skylight's does. */
export function accessTokenTtlSeconds(props: SkylightProps, now = Date.now()): number {
  const margin = 5 * 60;
  return Math.max(60, Math.floor((props.expiresAt - now) / 1000) - margin);
}

export function isSkylightProps(value: unknown): value is SkylightProps {
  const p = value as Partial<SkylightProps> | null;
  return (
    !!p &&
    typeof p.accessToken === "string" &&
    typeof p.refreshToken === "string" &&
    typeof p.fingerprint === "string" &&
    typeof p.expiresAt === "number" &&
    typeof p.frameId === "string" &&
    typeof p.timezone === "string" &&
    typeof p.hasPlus === "boolean"
  );
}
