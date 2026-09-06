# Guest Buy Now Freshness Verification

Signed-out Buy Now checkout is a critical read-after-write path. A shopper starts on a catalog item, chooses Buy Now, and expects the single POST to mint a guest identity and open checkout review before any payment or order exists.

## Contract

- Discovery redirects signed-out Buy Now submissions to `/checkout/buy/readiness` with a method-preserving `307` and the Buy Now source preserved.
- Checkout consumes that POST, starts guest checkout through Auth, writes the `chase_sets_guest_checkout` cookie on the document response, and redirects directly to `/checkout/buy/session/:sessionId` with an `afterWrite` receipt. The readiness route is a redirecting action hop, not a shopper form.
- Platform API freshness middleware must wait on the exact Checkout session dependency for `/api/marketplace/account/checkout-sessions/:sessionId`: `checkout.session-projection`, resolved from `checkout_session_pages`.
- While the fresh receipt is valid, `404`, `projection_freshness_timeout`, and bounded gateway/service timeout responses are temporary preparing-checkout states, not permanent checkout-session-not-found recovery. Internal API freshness timeouts can remain 503 JSON, but customer-facing checkout recovery documents must avoid 5xx statuses because the deployment edge owns generic 5xx error pages.
- Retrying or refreshing the same fresh URL must show the checkout session once `checkout_session_pages` catches up.
- Payment and order side effects are not allowed before the shopper explicitly confirms checkout.

## Shared Customer-Visible States

Use these state names for deterministic tests and synthetic canaries.

| State | Meaning | Expected UI/API behavior |
| --- | --- | --- |
| `pass` | Fresh session is readable. | Checkout session review renders and no payment/order exists before confirmation. |
| `temporary` | The fresh receipt is valid but the read model is still catching up. | Preparing-checkout recovery renders with a refresh/retry action and `Your payment has not started.`, and actively revalidates the same fresh read on a bounded schedule until the session is pay-ready or the receipt expires, then degrades to manual recovery. |
| `fail` | The path renders permanent not-found or drops the fresh receipt/guest cookie. | Canary/test fails immediately; this is the customer failure class from the staging incident. |

## Test Fixture Rules

- Prefer deterministic local integration fixtures for CI. Use synthetic catalog/listing/session ids that are owned by the test run.
- Guest identities created by browser or staging canaries must use a canary-specific email namespace and rely on guest token expiry or explicit environment cleanup.
- Do not reuse production customer emails, payment methods, orders, or long-lived guest tokens.
- Staging canaries must stop at checkout review. They must not click checkout confirmation, create payments, create orders, or reserve inventory.
- Cleanup should remove or expire canary-created guest checkout tokens and checkout sessions when the environment provides a cleanup hook. Where cleanup is TTL-based, the canary issue and runbook must state the expiry window.

## Verification Coverage

The #1074 integration coverage asserts:

- signed-out Buy Now single-POST guest entry and server-side guest identity creation;
- guest cookie handoff on the document redirect;
- `afterWrite` receipt preservation from the Checkout command response;
- fresh `404` retry to eventual session readiness;
- `projection_freshness_timeout` and bounded gateway/service timeout recovery as temporary preparing-checkout states;
- exact dependency diagnostics for `checkout_session_pages` resolving to `checkout.session-projection`;
- command-side Buy Now updates without reading `checkout_session_pages` while projection is behind;
- no payment/order side effects before explicit checkout confirmation.

The #1086 synthetic canary asserts the same `pass`, `temporary`, and `fail` states against staging, with a discovered or pinned canary-owned buyable fixture and no checkout confirmation. Since #1227 the canary covers both the guest flow and the authenticated account flow (signed-in Buy Now redirects directly to `/checkout/buy/session/:sessionId` with the `afterWrite` receipt and `chase_sets_session` cookie), enforces the write-to-checkout-ready release budget (`temporary` that never becomes pay-ready within the budget aborts promotion), and runs a negative invalid-session probe so recovery that masks a truly invalid checkout session as preparing-checkout fails the gate. Expired-token negative coverage remains owned by the deterministic #1074 integration suite; the canary owns the live invalid-session symptom. Production runs the same probe in proof mode (authenticated flow on the permission-gated proof host). See the [Guest Buy Now Freshness Probe](../../../docs/runbooks/guest-buy-now-freshness-probe.md) runbook for fixture ownership, release-health evidence, and production proof-mode rules.
