# Guest Buy Now Freshness Verification

Signed-out Buy Now checkout is a critical read-after-write path. A shopper starts on a catalog item, chooses Buy Now, enters guest contact details, and expects to review the checkout session before any payment or order exists.

## Contract

- Discovery redirects signed-out Buy Now submissions to `/checkout/start` with the Buy Now source preserved.
- Checkout starts guest checkout through Auth, writes the `chase_sets_guest_checkout` cookie on the document response, and redirects to `/checkout/:sessionId` with an `afterWrite` receipt.
- Platform API freshness middleware must wait on the exact Checkout session dependency for `/api/marketplace/account/checkout-sessions/:sessionId`: `checkout.session-projection`, resolved from `checkout_session_pages`.
- While the fresh receipt is valid, `404` and `projection_freshness_timeout` responses are temporary preparing-checkout states, not permanent checkout-session-not-found recovery.
- Retrying or refreshing the same fresh URL must show the checkout session once `checkout_session_pages` catches up.
- Payment and order side effects are not allowed before the shopper explicitly confirms checkout.

## Shared Customer-Visible States

Use these state names for deterministic tests and synthetic canaries.

| State | Meaning | Expected UI/API behavior |
| --- | --- | --- |
| `pass` | Fresh session is readable. | Checkout session review renders and no payment/order exists before confirmation. |
| `temporary` | The fresh receipt is valid but the read model is still catching up. | Preparing-checkout recovery renders with a refresh/retry action and `Your payment has not started.` |
| `fail` | The path renders permanent not-found or drops the fresh receipt/guest cookie. | Canary/test fails immediately; this is the customer failure class from the staging incident. |

## Test Fixture Rules

- Prefer deterministic local integration fixtures for CI. Use synthetic catalog/listing/session ids that are owned by the test run.
- Guest identities created by browser or staging canaries must use a canary-specific email namespace and rely on guest token expiry or explicit environment cleanup.
- Do not reuse production customer emails, payment methods, orders, or long-lived guest tokens.
- Staging canaries must stop at checkout review. They must not click checkout confirmation, create payments, create orders, or reserve inventory.
- Cleanup should remove or expire canary-created guest checkout tokens and checkout sessions when the environment provides a cleanup hook. Where cleanup is TTL-based, the canary issue and runbook must state the expiry window.

## Verification Coverage

The #1074 integration coverage asserts:

- signed-out Buy Now guest contact submission;
- guest cookie handoff on the document redirect;
- `afterWrite` receipt preservation from the Checkout command response;
- fresh `404` retry to eventual session readiness;
- `projection_freshness_timeout` recovery as a temporary preparing-checkout state;
- exact dependency diagnostics for `checkout_session_pages` resolving to `checkout.session-projection`;
- command-side Buy Now updates without reading `checkout_session_pages` while projection is behind;
- no payment/order side effects before explicit checkout confirmation.

The #1086 synthetic canary should assert the same `pass`, `temporary`, and `fail` states against staging, with canary-owned fixtures and no checkout confirmation.
