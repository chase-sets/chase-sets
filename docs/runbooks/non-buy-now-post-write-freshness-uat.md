# Non-Buy-Now Post-Write Freshness UAT

## Purpose

Use this checklist to collect Chrome staging evidence for post-write freshness flows that are not covered by the automated Buy Now canary. The release gate now requires telemetry for account-cart post-write consistency, Sell List accept-to-checkout handoffs, payout-ready handoffs, settlement payout errors, and projection lag/poison events. This UAT fills the remaining browser proof gap for account cart, Sell List, payout readiness, and listing freshness until each flow has owned live canary automation.

## Evidence Rules

Record only structural evidence:

- environment, release commit, checked timestamp, browser name, operator evidence reference
- route template or route id, never the full URL
- outcome code, visible state category, and latency bucket
- telemetry query result category: `zero`, `non_zero`, or `missing`

Do not record account ids, cart ids, event ids, compact tokens, raw `afterWrite`, session ids, emails, cookies, payment ids, order ids, listing ids, item details, provider payloads, full URLs, or screenshots containing those values. If a screenshot is needed for private triage, keep it outside PR comments, launch checklist rows, and release-health artifacts.

## Chrome Staging Checklist

1. Open Chrome with a clean staging session for an operator-owned account.
2. Record the release commit and evidence reference before starting.
3. Account cart: add an eligible listing to the account cart and navigate to `/account/cart`.
4. Confirm the cart applies the optimistic state, then reconciles to server-confirmed state without a freshness timeout.
5. Account cart stale response: perform a rapid quantity or remove/update sequence and confirm an older response cannot overwrite the newest visible cart state.
6. Generate the redacted account-cart artifact with `scripts/account-cart-consistency-canary.mjs`; the artifact must promote and must not contain sensitive values.
7. Sell List accept-to-checkout: from `/account/sell`, accept an eligible sell readiness flow into checkout and confirm the handoff reaches the expected checkout or readiness state without fallback failure.
8. Payout-ready return: use an operator-owned payout-ready account flow and confirm returning to Sell List shows payout readiness without setup-blocked recovery.
9. Listing freshness: create or update a staging listing through the account listing flow, then confirm `/account/listings`, `/account/listings/:id`, and the public listing/product surface show the expected fresh state or an owned temporary recovery state.
10. Query release canary telemetry for the same window using `infrastructure/observability/release-canary-prometheus-queries.json`.
11. Confirm required zero-failure signals are `zero`: `account-cart-post-write-consistency`, `sell-rail-accept-checkout-handoff`, `payout-ready-handoff`, `settlement-payout-errors`, and `projection-lag-poison-events`.
12. Record remaining gaps separately: listing freshness has Chrome UAT evidence but no dedicated live canary gate until fixture ownership, cleanup, and low-cardinality telemetry are explicit.

## Passing Evidence Shape

```json
{
  "schemaVersion": "non-buy-now-post-write-freshness-uat/v1",
  "environment": "staging",
  "releaseCommit": "<40-char-sha>",
  "checkedAt": "<iso>",
  "browser": "chrome",
  "evidenceReference": "STAGING-NON-BUY-NOW-FRESHNESS-YYYY-MM-DD",
  "flows": [
    { "name": "account-cart", "routeTemplate": "/account/cart", "outcome": "promote" },
    { "name": "sell-list-accept-to-checkout", "routeTemplate": "/account/sell", "outcome": "fresh" },
    { "name": "payout-ready-return", "routeTemplate": "/account/sell", "outcome": "fresh" },
    { "name": "listing-freshness", "routeTemplate": "/account/listings/:id", "outcome": "fresh-or-owned-temporary" }
  ],
  "telemetry": {
    "account-cart-post-write-consistency": "zero",
    "sell-rail-accept-checkout-handoff": "zero",
    "payout-ready-handoff": "zero",
    "settlement-payout-errors": "zero",
    "projection-lag-poison-events": "zero"
  },
  "remainingGap": "listing freshness is Chrome-UAT-only until a dedicated live canary owns fixture setup and cleanup"
}
```
