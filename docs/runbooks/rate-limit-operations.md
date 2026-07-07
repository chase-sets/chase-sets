# Rate Limit Operations

Chase Sets rate limits are enforced per API instance with in-memory buckets for the current single-instance API topology. The shared limiter exposes a storage seam through `@chase-sets/http/rate-limit`; move the same surface keys to a Postgres or Redis store before horizontally scaling the API beyond the current production gate.

## Runtime Configuration

Each surface can be tuned with environment variables:

- `CHASE_SETS_RATE_LIMIT_<SURFACE>_MAX`
- `CHASE_SETS_RATE_LIMIT_<SURFACE>_WINDOW_MS`
- `CHASE_SETS_RATE_LIMIT_<SURFACE>_DISABLED=true`

Surface names are uppercased with punctuation converted to underscores. For example, `auth.magic-link.request.identifier` uses `CHASE_SETS_RATE_LIMIT_AUTH_MAGIC_LINK_REQUEST_IDENTIFIER_MAX`.

`CHASE_SETS_RATE_LIMITS_DISABLED=true` disables all shared limiter surfaces and is intended only for emergency rollback.

## Environment Posture

Production runs the documented defaults unless an incident response explicitly tunes a surface.

Staging keeps rate limits active so deploy smoke exercises the same limiter behavior as production. The staging App Platform API sets `CHASE_SETS_RATE_LIMIT_AUTH_REGISTER_IP_MAX=30` so the deployed smoke suite's serial synthetic-account registrations and Playwright retries fit inside the one-hour `auth.register.ip` window from a single GitHub runner IP without disabling abuse protection.

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
