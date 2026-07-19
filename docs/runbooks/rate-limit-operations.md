# Rate Limit Operations

Chase Sets rate limits are enforced per API instance with in-memory buckets for the current single-instance API topology. The shared limiter exposes a storage seam through `@chase-sets/http/rate-limit`; move the same surface keys to a Postgres or Redis store before horizontally scaling the API beyond the current production gate.

## Policy-Backed Surfaces (m110 #4290)

Five surfaces were born as compiled constants and have been migrated onto the shared `platform-policy` machinery so they can be tuned without a deploy:

- `checkout.anonymous-rail-capture` (both `checkout:anonymous-cart-capture` and `checkout:anonymous-sell-list-capture` buckets share this one policy dial)
- `discovery.product-alert.anonymous-capture`
- `marketplace.anonymous-listing-draft.capture`
- `marketplace.public-standard-terms-preview`
- `public-presence.waitlist.submit`

These surfaces read a `createPolicyBackedRateLimiter` instance instead of a static `createInMemoryRateLimiter`. Platform Operations owns the single `platform-operations.rate-limits` policy document (see `bounded-contexts/platform-operations/features/rate-limit-policy`), admin-managed via `POST`/`PUT /api/platform/rate-limit-policy` (gated by the `security.manage` permission). Its value carries:

- **Per-surface overrides** (`surfaces.<key>.max` / `.windowMs` / `.disabled`) -- tune or kill-switch one surface without touching any other.
- **`incidentMultiplier`** (0.1-10, default 1) -- a single dial that divides every resolved surface's `max` at once (clamped to a minimum of 1 request). Set it above 1 during a launch wave or abuse spike to tighten everything; below 1 to loosen a specific rollout.

An unset policy resolves every surface to its compiled fallback byte-for-byte, so an empty or unreachable policy table never breaks the hot path -- the resolver fails safe to compiled defaults if the policy store errors.

**Propagation**: Platform Operations' own admin routes read through the push-invalidated `platform-policy` cache (a policy revision is visible immediately -- no polling). The four cross-context consumers (Checkout, Discovery, Marketplace, Public Presence) read through a `rateLimitPolicyResolver` host port that memoizes the whole policy value for ~1 second per process before re-querying -- deliberately avoiding an uncached Postgres read on every incoming request (including the flood of requests an abusive client sends specifically to defeat the limiter). Expect a revision to change enforcement on these four surfaces within about one second, not immediately and never after a deploy.

The m107 surfaces below (env-only today, born before this mechanism existed) are candidates to adopt the same `createPolicyBackedRateLimiter` factory in a follow-up; env overrides remain the mechanism for them until then.

## Runtime Configuration

Each surface can be tuned with environment variables:

- `CHASE_SETS_RATE_LIMIT_<SURFACE>_MAX`
- `CHASE_SETS_RATE_LIMIT_<SURFACE>_WINDOW_MS`
- `CHASE_SETS_RATE_LIMIT_<SURFACE>_DISABLED=true`

Surface names are uppercased with punctuation converted to underscores. For example, `auth.magic-link.request.identifier` uses `CHASE_SETS_RATE_LIMIT_AUTH_MAGIC_LINK_REQUEST_IDENTIFIER_MAX`.

`CHASE_SETS_RATE_LIMITS_DISABLED=true` disables all shared limiter surfaces and is intended only for emergency rollback.

## Environment Posture

Production runs the documented defaults unless an incident response explicitly tunes a surface.

Staging keeps rate limits active so deploy smoke exercises the same limiter behavior as production. The staging Helm values set `CHASE_SETS_RATE_LIMIT_AUTH_REGISTER_IP_MAX=30` so the deployed smoke suite's serial synthetic-account registrations and Playwright retries fit inside the one-hour `auth.register.ip` window from a single GitHub runner IP without disabling abuse protection.

## Defaults

| Surface | Default |
| --- | --- |
| `auth.sign-in.ip-failures` | 5 failed attempts / 5 minutes |
| `auth.sign-in.identifier-failures` | 5 failed attempts / 5 minutes |
| `auth.register.ip` | 3 attempts / 1 hour |
| `auth.magic-link.request.identifier` | 3 attempts / 1 hour |
| `auth.magic-link.request.ip` | 10 attempts / 1 hour |
| `auth.magic-link.consume.ip` | 10 attempts / 10 minutes |
| `auth.magic-link.consume.token` | 5 attempts / 10 minutes |
| `auth.invitation.acceptance-link.ip` | 10 attempts / 1 hour |
| `auth.invitation.acceptance-link.identifier` | 3 attempts / 1 hour |
| `auth.invitation.accept.ip` | 10 attempts / 1 hour |
| `auth.invitation.accept.identifier` | 5 attempts / 1 hour |
| `auth.guest-checkout.claim.ip` | 20 attempts / 1 hour |
| `auth.guest-checkout.claim.account` | 5 attempts / 1 hour |
| `marketplace.offer.submit.account` | 50 attempts / 1 day |
| `marketplace.offer.submit.ip` | 20 attempts / 1 hour |
| `marketplace.offer.accept.account` | 100 attempts / 1 day |
| `marketplace.offer.accept.ip` | 60 attempts / 1 hour |
| `payments.payment.create.account` | 10 attempts / 10 minutes |
| `payments.payment.create.ip` | 20 attempts / 10 minutes |
| `payments.card-decline.fingerprint` | 5 declined card attempts / 1 hour |

Webhook ingress and internal service traffic are intentionally not rate limited by these surfaces.
