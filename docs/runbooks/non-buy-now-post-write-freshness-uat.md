# Non-Buy-Now Post-Write Freshness UAT

## Purpose

Use this checklist to collect Chrome staging evidence for post-write freshness flows that are not covered by the automated Buy Now canary. Release-health review now expects telemetry for account-cart post-write consistency, Sell List accept-to-checkout handoffs, payout-ready handoffs, Marketplace listing freshness, settlement payout errors, and projection lag/poison events. This UAT fills the remaining browser proof gap for account cart, Sell List, payout readiness, and listing freshness until each flow has owned live canary automation.

## Evidence Rules

Record only structural evidence:

- environment, release commit, checked timestamp, browser name, operator evidence reference
- route template or route id, never the full URL
- outcome code, visible state category, and latency bucket
- telemetry query result category: `zero`, `within-slo`, `non_zero`, or `missing`

Do not record account ids, cart ids, event ids, compact tokens, raw `afterWrite`, session ids, emails, cookies, payment ids, order ids, listing ids, item details, provider payloads, full URLs, or screenshots containing those values. If a screenshot is needed for private triage, keep it outside PR comments, launch checklist rows, and release-health artifacts.

## Chrome Staging Checklist

1. Open Chrome with a clean staging session for an operator-owned account.
2. Record the release commit and evidence reference before starting.
3. Account cart: add an eligible listing to the account cart and navigate to `/account/cart`.
4. Confirm the cart applies the optimistic state, then reconciles to server-confirmed state without a freshness timeout.
5. Account cart stale response: perform a rapid quantity or remove/update sequence and confirm an older response cannot overwrite the newest visible cart state.
6. Generate the redacted account-cart artifact with `scripts/account-cart-consistency-probe.mjs`; the artifact must promote and must not contain sensitive values.
7. Sell List accept-to-checkout: from `/account/sell`, accept an eligible sell readiness flow into checkout and confirm the handoff reaches the expected checkout or readiness state without fallback failure.
8. Before payout-ready return or listing freshness, run the `Platform Staging Representative Commerce State` workflow for the deployed release ref and read the `chromeUatSelector` object from `representative-commerce-state.complete`. Continue only when `chromeUatSelector.status` is `ready`.
9. Use `chromeUatSelector.selectedPersonaAlias` with private operator login tooling to open Chrome as that staging persona. Public evidence may name only the alias and selector categories, not the email, account id, provider reference, listing id, item detail, token, or full URL.
10. Payout-ready return: with the selected persona, return to `/account/sell` and confirm payout readiness is visible without setup-blocked recovery. If the selector reports `payout-not-ready`, stop and complete private payout setup first; do not substitute sandbox provider smoke evidence.
11. Listing freshness: create or update a fixture-owned staging listing through the account listing flow, then confirm `/account/listings`, `/account/listings/:id`, and the public listing/product surface show the expected fresh state or an owned temporary recovery state.
12. Cleanup: restore the updated listing fields or withdraw any temporary listing before ending the UAT window. If immediate cleanup is blocked, record the private cleanup owner and a 24-hour TTL outside public evidence.
13. Query the same window in Grafana/Prometheus using the Projection Freshness dashboard and the starter queries in [Observability](./observability.md).
14. Confirm the telemetry observations are `zero` or within SLO: `account-cart-post-write-consistency`, `sell-rail-accept-checkout-handoff`, `payout-ready-handoff`, `marketplace-listing-freshness-slo`, `settlement-payout-errors`, and `projection-lag-poison-events`.
15. Record remaining gaps separately: listing freshness has low-cardinality telemetry but no dedicated live mutation canary or automated comparison gate until fixture ownership and cleanup are explicit.
16. Include the generated UAT JSON in the release-health report input so the Projection Freshness Evidence section records account cart, Sell List, payout, and listing coverage:

```powershell
pnpm run ops release-health:report `
  --dir .\artifacts\release-health `
  --file .\artifacts\release-health\non-buy-now-post-write-freshness-uat.json `
  --out .\artifacts\release-health\summary.md
```

The report fails the UAT row when any required flow is missing, when telemetry is `missing` or `non_zero`, or when the artifact contains private identifiers. Keep screenshots and private browser notes outside the report artifact.

## Passing Evidence Shape

```json
{
  "schemaVersion": "non-buy-now-post-write-freshness-uat/v1",
  "environment": "staging",
  "releaseCommit": "<40-char-sha>",
  "checkedAt": "<iso>",
  "browser": "chrome",
  "evidenceReference": "STAGING-NON-BUY-NOW-FRESHNESS-YYYY-MM-DD",
  "chromeUatPersonaAlias": "card-vault",
  "chromeUatSelectorStatus": "ready",
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
    "marketplace-listing-freshness-slo": "within-slo",
    "settlement-payout-errors": "zero",
    "projection-lag-poison-events": "zero"
  },
  "remainingGap": "listing freshness is telemetry-backed but still needs a dedicated live mutation canary and automated comparison gate once fixture setup and cleanup are explicit"
}
```
