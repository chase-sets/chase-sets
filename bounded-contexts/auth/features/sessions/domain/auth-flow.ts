import type { SocialLoginProviderKey } from "@chase-sets/auth-context";

export type AuthMethod = "password" | "magic-link" | "passkey" | "sms-code" | SocialLoginProviderKey;

export const AUTH_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
export const AUTH_ACCOUNT_SELECTION_TTL_MS = 1000 * 60 * 10;
export const AUTH_MAGIC_LINK_TTL_MS = 1000 * 60 * 15;
export const AUTH_CHALLENGE_TTL_MS = 1000 * 60 * 10;
export const AUTH_SOCIAL_LOGIN_STATE_TTL_MS = 1000 * 60 * 10;
export const AUTH_GUEST_CHECKOUT_TTL_MS = 1000 * 60 * 60 * 24;
export const UCP_OAUTH_ACCESS_TOKEN_TTL_MS = 1000 * 60 * 60;
export const UCP_OAUTH_REFRESH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;
export const UCP_OAUTH_AUTHORIZATION_CODE_TTL_MS = 1000 * 60 * 5;

export const AUTH_SESSION_STREAM_PREFIX = "auth.session-";

/**
 * Security lifetimes: session tokens, account-selection tokens, magic
 * links, WebAuthn/OTP challenges, social-login state, guest checkout
 * tokens, and UCP OAuth token TTLs.
 *
 * These are ENV-TIER BY DESIGN, never admin-policy-editable: a compromised
 * admin session must not be able to stretch a session lifetime or shorten an
 * OTP window. A future slice must NOT migrate these onto the shared
 * `infrastructure/platform-policy` admin-editable machinery -- see
 * `docs/architecture` and `bounded-contexts/auth/docs/security-lifetimes.md`
 * for the recorded exclusion. Deployable config readers (env) are the only
 * sanctioned override path; see `AuthHostPorts.securityLifetimes` in
 * `runtime-support/services.ts`.
 */
export type AuthSecurityLifetimesMs = Readonly<{
  sessionTtlMs: number;
  accountSelectionTtlMs: number;
  magicLinkTtlMs: number;
  challengeTtlMs: number;
  socialLoginStateTtlMs: number;
  guestCheckoutTtlMs: number;
  ucpAccessTokenTtlMs: number;
  ucpRefreshTokenTtlMs: number;
  ucpAuthorizationCodeTtlMs: number;
}>;

type AuthSecurityLifetimeBoundsMs = Readonly<{ minMs: number; maxMs: number }>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Bounds are deliberately generous but finite: wide enough that a legitimate
// deploy-time tuning need is never blocked, narrow enough that a fat-fingered
// env value cannot zero out an expiry or grant an unbounded-lifetime token.
export const AUTH_SECURITY_LIFETIME_BOUNDS_MS: Readonly<
  Record<keyof AuthSecurityLifetimesMs, AuthSecurityLifetimeBoundsMs>
> = {
  sessionTtlMs: { minMs: HOUR_MS, maxMs: 30 * DAY_MS },
  accountSelectionTtlMs: { minMs: MINUTE_MS, maxMs: HOUR_MS },
  magicLinkTtlMs: { minMs: 5 * MINUTE_MS, maxMs: HOUR_MS },
  challengeTtlMs: { minMs: MINUTE_MS, maxMs: 30 * MINUTE_MS },
  socialLoginStateTtlMs: { minMs: MINUTE_MS, maxMs: HOUR_MS },
  guestCheckoutTtlMs: { minMs: HOUR_MS, maxMs: 30 * DAY_MS },
  ucpAccessTokenTtlMs: { minMs: 5 * MINUTE_MS, maxMs: DAY_MS },
  ucpRefreshTokenTtlMs: { minMs: DAY_MS, maxMs: 90 * DAY_MS },
  ucpAuthorizationCodeTtlMs: { minMs: 30_000, maxMs: 15 * MINUTE_MS },
};

export const DEFAULT_AUTH_SECURITY_LIFETIMES_MS: AuthSecurityLifetimesMs = {
  sessionTtlMs: AUTH_SESSION_TTL_MS,
  accountSelectionTtlMs: AUTH_ACCOUNT_SELECTION_TTL_MS,
  magicLinkTtlMs: AUTH_MAGIC_LINK_TTL_MS,
  challengeTtlMs: AUTH_CHALLENGE_TTL_MS,
  socialLoginStateTtlMs: AUTH_SOCIAL_LOGIN_STATE_TTL_MS,
  guestCheckoutTtlMs: AUTH_GUEST_CHECKOUT_TTL_MS,
  ucpAccessTokenTtlMs: UCP_OAUTH_ACCESS_TOKEN_TTL_MS,
  ucpRefreshTokenTtlMs: UCP_OAUTH_REFRESH_TOKEN_TTL_MS,
  ucpAuthorizationCodeTtlMs: UCP_OAUTH_AUTHORIZATION_CODE_TTL_MS,
};

/**
 * Merges deployable-supplied overrides onto the compiled defaults and
 * bounds-checks every field, throwing a clear, field-named error on the
 * first out-of-bounds or non-positive value. Called once at host boot
 * (`createAuthServices`) so a misconfigured lifetime fails closed before any
 * request is served, never silently at first use.
 */
export function resolveAuthSecurityLifetimesMs(
  overrides: Partial<AuthSecurityLifetimesMs> = {},
): AuthSecurityLifetimesMs {
  const resolved = { ...DEFAULT_AUTH_SECURITY_LIFETIMES_MS, ...overrides } as AuthSecurityLifetimesMs;

  for (const key of Object.keys(AUTH_SECURITY_LIFETIME_BOUNDS_MS) as (keyof AuthSecurityLifetimesMs)[]) {
    const bounds = AUTH_SECURITY_LIFETIME_BOUNDS_MS[key];
    const value = resolved[key];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Auth security lifetime "${key}" must be a positive number of milliseconds.`);
    }
    if (value < bounds.minMs || value > bounds.maxMs) {
      throw new Error(
        `Auth security lifetime "${key}" (${value}ms) must be between ${bounds.minMs}ms and ${bounds.maxMs}ms.`,
      );
    }
  }

  return resolved;
}

/**
 * Safe accessor for callers holding a services-shaped object that may omit
 * `securityLifetimes` (unit-test doubles that only stub the fields their
 * scenario touches). Real hosts always populate it via `createAuthServices`;
 * this fallback keeps compiled defaults as the behavior when it is absent,
 * matching prior hardcoded behavior exactly.
 */
export function authSecurityLifetimesOf(services: {
  securityLifetimes?: AuthSecurityLifetimesMs;
}): AuthSecurityLifetimesMs {
  return services.securityLifetimes ?? DEFAULT_AUTH_SECURITY_LIFETIMES_MS;
}

export function createExpiryTimestamp(durationMs: number, now = Date.now()) {
  return new Date(now + durationMs).toISOString();
}

export function toSessionStreamId(sessionId: string) {
  return `${AUTH_SESSION_STREAM_PREFIX}${sessionId}`;
}
