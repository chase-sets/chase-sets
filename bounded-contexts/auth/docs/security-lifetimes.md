# Security Lifetimes (issue #4292)

Auth owns nine security-sensitive lifetimes: session tokens, account-selection tokens, magic links, WebAuthn/OTP challenges, social-login state, guest checkout tokens, and the three UCP OAuth token TTLs (access, refresh, authorization code).

## Env-tier by design -- deliberately NOT admin-editable

These lifetimes are environment configuration, not platform-policy documents. The 2026-07-05 hardcoded-values audit (epic #4294) placed them in "Tier 4": runtime-configurable, but only through env with deploy review. **The admin policy surface (`infrastructure/platform-policy`, the `definePolicy` machinery used by commercial-terms, settlement clearance, support-request deadlines, and rate limits) must never grow an auth-lifetime policy.** A compromised admin session must not be able to stretch a session lifetime or shorten an OTP window -- the deploy-review friction on these values is the feature, not an oversight to "helpfully" remove by migrating them onto the shared runtime-configurable-policy machinery.

If a future slice is tempted to move one of these onto `definePolicy`, that is the wrong direction: revert to env. See the guard comment at the top of `bounded-contexts/auth/features/sessions/domain/auth-flow.ts` and at the top of `infrastructure/platform-policy/define-policy.ts`.

## Values, defaults, and bounds

| Lifetime | Env var | Default | Bounds |
| --- | --- | --- | --- |
| Session TTL | `AUTH_SESSION_TTL_MS` | 14 days | 1 hour – 30 days |
| Account-selection TTL | `AUTH_ACCOUNT_SELECTION_TTL_MS` | 10 minutes | 1 – 60 minutes |
| Magic-link TTL | `AUTH_MAGIC_LINK_TTL_MS` | 15 minutes | 5 – 60 minutes |
| Auth challenge TTL (WebAuthn/passkey) | `AUTH_CHALLENGE_TTL_MS` | 10 minutes | 1 – 30 minutes |
| Social-login state TTL | `AUTH_SOCIAL_LOGIN_STATE_TTL_MS` | 10 minutes | 1 – 60 minutes |
| Guest checkout token TTL | `AUTH_GUEST_CHECKOUT_TTL_MS` | 24 hours | 1 hour – 30 days |
| UCP OAuth access token TTL | `UCP_OAUTH_ACCESS_TOKEN_TTL_MS` | 1 hour | 5 minutes – 24 hours |
| UCP OAuth refresh token TTL | `UCP_OAUTH_REFRESH_TOKEN_TTL_MS` | 30 days | 1 – 90 days |
| UCP OAuth authorization code TTL | `UCP_OAUTH_AUTHORIZATION_CODE_TTL_MS` | 5 minutes | 30 seconds – 15 minutes |

Every default equals the pre-#4292 compiled constant, so an unconfigured deploy is byte-identical to before. The invitation-acceptance-link TTL and the checkout guest cookie's `Max-Age` both derive from these values (magic-link and guest-checkout TTL respectively) rather than duplicating their own constants, so there is exactly one source of truth per lifetime.

## Where this lives in code

- `bounded-contexts/auth/features/sessions/domain/auth-flow.ts` -- `AuthSecurityLifetimesMs`, `AUTH_SECURITY_LIFETIME_BOUNDS_MS`, `DEFAULT_AUTH_SECURITY_LIFETIMES_MS`, `resolveAuthSecurityLifetimesMs` (bounds validator), `authSecurityLifetimesOf` (safe accessor).
- `bounded-contexts/auth/support/runtime-support/services.ts` -- `AuthHostPorts.securityLifetimes` (deployable-supplied overrides) and `AuthServices.securityLifetimes` (resolved, bounds-checked).
- `deployables/platform-api/src/config.ts` -- `loadAuthSecurityLifetimesConfig` reads and bounds-checks the nine env vars at boot; `deployables/platform-api/src/main.ts` threads the result into `hostPorts.securityLifetimes`.
- `bounded-contexts/auth/support/ucp-support/oauth.ts` -- reads the UCP TTL fields off `options.auth.securityLifetimes`.

## Bounds enforcement

Both `deployables/platform-api/src/config.ts` (`getBoundedDurationEnv`) and `resolveAuthSecurityLifetimesMs` bounds-check every value and throw with a field-named, bounds-naming message on the first out-of-range or non-positive value. Both run synchronously during host boot -- before the server starts listening -- so a misconfigured lifetime fails the deploy instead of shipping and failing silently at first use.
