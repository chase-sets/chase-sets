# Chase Sets Launch Checklist

**Purpose:** Single frozen launch checklist for the Shopify-simple checkout (Milestone #17). Replaces the per-PR evidence ledgers and review-pass requirements accumulated in issues #1115 and #1116 (per issue #1320).

**Rule:** This list is frozen. Additions require a new issue with rationale. The list is reviewed once, at actual launch — it is not enforced per-PR.

**Proof validity (issue #1414):** launch proof is **monotonic**. Evidence recorded against a main commit X remains valid for every descendant of X unless a later change touches the covered surface (as classified by `scripts/change-scope.mjs`). A merge to main does not invalidate prior proof; "current-main revalidation" passes are not required and must not be requested. Evidence rows are recorded **only in this file via pull request** — never as issue or milestone comments. Evidence minimums (matrix row counts, scenario counts, artifact counts) change only by editing this file via pull request; review passes may not raise them.

**Owner:** Todd

**How to use:** Walk the list top to bottom in a production-like environment. "Baseline" citations point to the PR/deploy where the behavior was first proven — spot-check that it still holds; do not rebuild evidence matrices.

## Buy flows

- [ ] Guest buy: cart review → checkout → payment → confirmation completes end to end with a Stripe test card, no account required.
- [ ] Signed-in buy: saved contact/address/payment rows render, are editable, and checkout completes (UI baseline: PR #1256 / deploy 27255399723; runtime baseline: PR #1258 / deploy 27259042276).
- [ ] Buy Now works for guest and signed-in and lands on checkout review or a checkout-owned "preparing" recovery, never a blank or platform error page (baseline: PR #1212).
- [ ] A multi-seller cart presents one payment action and one confirmation; per-group orders are visible afterward in account history.
- [ ] Reload, back/forward, and double-clicking the pay button during checkout never create duplicate payments or orders (buy confirmation retry baseline: PR #1499).

## Sell flows

- [ ] Signed-in sell: list review → readiness → checkout → explicit confirmation records the sale and Marketplace handoff (baseline: PR #1289 / deploy 27324899046).
- [ ] Stale offer terms at final confirmation route the seller back to sell-list recovery with no listing/acceptance side effects (baseline: PR #1300).
- [ ] Sell blockers (item eligibility, condition, ship-from, label, payout setup) are resolved in the sell list, never inside checkout (guest registration-first entry baseline: PR #1497).
- [ ] Guest sell is registration-first at launch: anonymous sellers can prepare a Sell List, but seller checkout routes through registration after readiness passes; missing, stale, or blocked readiness fails closed before seller-committing side effects (baseline: PR #1497).

## Checkout entry and readiness

- [ ] Checkout can only start from a fresh readiness snapshot; missing, stale, partial, or legacy-shaped state fails closed back to cart/list recovery (buy baseline: PR #1193; sell baseline: PR #1202).
- [ ] Items without a fulfillment assignment stay out of checkout and are resolved in cart or the pre-checkout step (cart readiness baseline: PR #1193; buy runtime baseline: PR #1456).
- [ ] Optional savings optimization is offered before checkout, and both accepted and declined decisions carry into checkout correctly (baseline: PR #1495).
- [ ] An active checkout session revalidates freshness (readiness, prices, address, risk, provider state) on return/reload/provider-return and before final confirmation; stale sessions route back to cart/list with no side effects (split-group handoff baseline: PR #1453; address/serviceability baseline: PR #1454; deferred economics input baseline: PR #1455; guest saved-instrument bypass baseline: PR #1458; guest saved-payment action baseline: PR #1485).

## Confirmation and downstream handoff

- [ ] Confirmation shows order/sale reference, totals, and a support-safe reference for both buy and sell (baseline: PR #1528).
- [ ] Buyer orders appear in account history; seller confirmations appear as pending activity until Ordering/Fulfillment/Settlement commit their own facts (baseline: PR #1296 / deploy 27330007592).
- [ ] No surface ever shows a pending confirmation as a completed sale, order, label, payout, or settlement (seller pending confirmation surfaces baseline: PR #1504).
- [ ] No money, order, label, payout, or notification side effects start before explicit final confirmation (runtime guard baselines: PR #1453, PR #1454, PR #1455, PR #1456, PR #1458, PR #1485).

## Payments / Stripe

- [ ] A real production-mode Stripe payment succeeds; a declined card shows customer-safe recovery and leaves no partial order.
- [ ] Webhook replays and payment retries do not duplicate charges, orders, or payouts (buy payment retry source-reference baseline: PR #1499).
- [ ] Customer-facing `deferPayment` is disabled; the internal proof-only helper remains permission-gated and audited (baseline: PR #1258).
- [ ] Refund and void can be executed by an operator, or are recorded as owner-approved deferrals with a support runbook.

## Notifications

- [ ] Buyer order-confirmation notification sends with correct totals and support reference.
- [ ] Seller sale notification sends when the owning context commits the fact, not on pending handoff.
- [ ] A notification failure does not block the order, and retries do not send duplicates.

## Support and observability

- [ ] Support can look up any checkout, order, or sale by support-safe reference — including pending confirmations before downstream IDs exist.
- [ ] Checkout entry, recovery, confirmation, and failure states emit observability events visible on a dashboard.
- [ ] Support runbooks cover: stuck checkout, payment dispute, missing/failed downstream handoff, and refund requests (runbook coverage baseline: PR #1513).

## Reconciliation and reversal paths

- [ ] Reconciliation can match payments → orders → payouts; an orphaned payment or missing order is detectable, not silent (policy baseline: PR #1448).
- [ ] Refund, payment void, label cancellation, and payout hold/reversal each work, or are owner-approved launch deferrals with customer-safe copy and a support path (policy baseline: PR #1449).
- [ ] Operator recovery actions are audited (policy baseline: PR #1449).

## Kill switches and recovery

- [ ] The checkout kill switch blocks entry with a customer-safe "checkout unavailable" state — verified on and off in staging.
- [ ] Kill switch, rollback, and provider-outage states fail closed into cart/list recovery and never resurrect the legacy dense checkout, old routes, or old payloads.

## Security, privacy, legal

- [ ] Security/privacy/legal review is signed off (#1124); no raw card data touches our servers; PII is redacted from logs and canary artifacts.
- [ ] Terms, privacy, and refund policy are linked from checkout; guest data handling is reviewed (checkout policy link baseline: PR #1509).
- [ ] Internal-only helpers (proof modes, diagnostics) are permission-gated and unreachable by customers (internal-helper security baseline: PR #1539).

## Performance

- [ ] Checkout meets the performance budgets on production for Buy Now, cart, and sell-list entry (budget contract baseline: PR #1303).
- [ ] The production proof-mode Buy Now canary reaches pay-ready checkout within the ready SLO. Current-main evidence: deploy 27398499167 passed with `readyLatencyMs=8170` against `readySloMs=10000`; earlier `checkout-ready-slo-exceeded` and temporary-recovery rows remain classified in #1116/#1123.
- [ ] Slow or degraded states render checkout-owned recovery before any gateway timeout, with no side effects attempted.

## Fresh-state / legacy deletion

- [ ] Legacy dense checkout routes, UI, and copy are deleted or hard-disabled; old checkout links and old session payloads fail closed with safe recovery. Fresh buy route/delete baseline: PR #1535.
- [ ] Pre-launch fixtures, seeds, cached read models, and provider sandbox objects are regenerated around the new contracts; guard tests fail if legacy patterns are reintroduced. Guard baseline: PR #1535.
- [ ] Any retained legacy artifact is listed in the exception register with owner, internal-only rationale, and expiration/follow-up — otherwise it is removed. Exception-register baseline: PR #1535.

## Provider configuration (Stripe / EasyPost)

- [ ] Stripe production keys and signed webhooks are configured and verified with a live test transaction. Provider configuration baseline: PR #1541.
- [ ] EasyPost production credentials and a label purchase are verified, or labels are recorded as an owner-approved deferral. Provider configuration baseline: PR #1541.
- [ ] No production configuration references sandbox objects or test credentials. Provider configuration baseline: PR #1541.

## Final gate

- [ ] CI launch-evidence gate (PR #1314 / PR #1318) passes on current main with `PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_APPROVED` and its evidence reference set.
- [ ] Todd has walked this checklist and signed off.
