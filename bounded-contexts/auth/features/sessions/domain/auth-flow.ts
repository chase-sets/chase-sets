import type { SocialLoginProviderKey } from "@chase-sets/auth-context";

export type AuthMethod = "password" | "magic-link" | "passkey" | "sms-code" | SocialLoginProviderKey;

export const AUTH_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
export const AUTH_ACCOUNT_SELECTION_TTL_MS = 1000 * 60 * 10;
export const AUTH_MAGIC_LINK_TTL_MS = 1000 * 60 * 15;
export const AUTH_CHALLENGE_TTL_MS = 1000 * 60 * 10;
export const AUTH_SOCIAL_LOGIN_STATE_TTL_MS = 1000 * 60 * 10;

export const AUTH_SESSION_STREAM_PREFIX = "auth.session-";

export function createExpiryTimestamp(durationMs: number, now = Date.now()) {
  return new Date(now + durationMs).toISOString();
}

export function toSessionStreamId(sessionId: string) {
  return `${AUTH_SESSION_STREAM_PREFIX}${sessionId}`;
}
