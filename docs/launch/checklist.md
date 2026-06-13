# Chase Sets Checkout Launch Checklist

**Purpose:** Customer-safety checklist for the Shopify-simple Buy Cart and Sell List checkout launch.

**Principles:** Chase Sets has not launched, so checkout ships as a fresh flow. Do not build migration paths, dense-checkout fallbacks, old session adapters, stale fixture support, dual writes, or customer-facing compatibility layers. Keep proof practical: tests, PR baselines, production-like smoke, and provider proof are enough when they cover the actual risk.

**Use:** Walk this once before public launch, and revisit only rows whose code or provider surface changed after proof landed.

## Buy Flows

- [ ] Guest buy: cart review -> checkout -> payment -> confirmation completes with no account required (baseline: PR #1549).
- [ ] Signed-in buy: saved contact, address, and payment rows render, are editable, and checkout completes (baseline: PR #1550).
- [ ] Buy Now works for guest and signed-in buyers, landing on checkout review or checkout-owned preparing recovery instead of a blank/platform/old-checkout page (baseline: PR #1212; proof: PR #1599).
- [ ] A multi-seller cart still presents one payment action and one confirmation; group details remain available afterward for account history and support.
- [ ] Reload, back/forward, and duplicate pay actions never create duplicate payments or orders (baseline: PR #1499).

## Sell Flows

- [ ] Signed-in sell: list review -> readiness -> checkout -> explicit confirmation records the pending sale handoff (baseline: PR #1289).
- [ ] Guest sell is registration-first at launch: anonymous sellers can prepare a Sell List, but seller checkout requires registration before seller-committing side effects (baseline: PR #1497).
- [ ] Sell blockers such as item eligibility, condition, ship-from, label, payout setup, and fallback-listing choice are resolved in Sell List, registration, or onboarding, not checkout (baseline: PR #1497).
- [ ] Stale or blocked sell readiness fails closed back to Sell List recovery with no listing, sale, label, payout, settlement, notification, or account-history side effects (baseline: PR #1300).

## Entry And Readiness

- [ ] Checkout starts only from a fresh readiness snapshot with ownership/fresh-write evidence; missing, stale, partial, or old-shaped state fails closed to cart/list recovery (buy baseline: PR #1193; sell baseline: PR #1202; proof: PR #1598).
- [ ] Items without fulfillment assignment stay out of checkout and are resolved in cart, Sell List, or a conditional pre-checkout step (cart baseline: PR #1193; runtime baseline: PR #1456; proof: PR #1598).
- [ ] Optional fulfillment savings is offered before checkout, and accepted or declined decisions carry into checkout as readiness evidence (baseline: PR #1495; proof: PR #1598).
- [ ] Active checkout sessions revalidate readiness, prices, address/serviceability, risk, and provider state before confirmation; stale sessions recover without side effects (baselines: PR #1453, PR #1454, PR #1455, PR #1458, PR #1485).

## Confirmation And Handoff

- [ ] Confirmation shows totals and a support-safe reference for buy and sell (baseline: PR #1528).
- [ ] Buyer order history and seller pending activity show the right pending or committed state without pretending downstream owner facts already exist (baselines: PR #1296, PR #1504).
- [ ] No money, order, label, payout, settlement, notification, account-history, refund, void, or reversal side effect starts before explicit final confirmation (runtime baselines: PR #1453, PR #1454, PR #1455, PR #1456, PR #1458, PR #1485).
- [ ] Support can look up pending and committed checkout states by support-safe reference.

## Payments, Providers, And Recovery

- [ ] Stripe production-mode payment succeeds, and declined-card recovery leaves no partial order.
- [ ] Stripe webhook replays and payment retries do not duplicate charges, orders, labels, payouts, or notifications (baseline: PR #1499).
- [ ] Customer-facing `deferPayment` is disabled; any internal proof helper is permission-gated and unreachable by customers (baseline: PR #1539).
- [ ] Refund, void, label cancellation, payout hold/reversal, and operator recovery either work through owned actions or are launch-disabled in code with customer-safe support copy (policy baseline: PR #1449).
- [ ] EasyPost production mode and label purchase are verified before enabling label purchase; otherwise label purchase remains launch-disabled with safe copy (provider baseline: PR #1541).

## Notifications, Support, And Observability

- [ ] Buyer and seller transactional notifications send only from the owning committed facts and include correct totals/support references where customer-visible.
- [ ] Notification failure does not block checkout completion, and retries suppress duplicates.
- [ ] Checkout entry, recovery, confirmation, provider-return, failure, and no-side-effect states emit redacted observability signals usable by support.
- [ ] Support runbooks cover stuck checkout, payment dispute, missing/failed downstream handoff, and refund requests (baseline: PR #1513).

## Security, Performance, And Fresh State

- [ ] No raw card, bank, provider secret, webhook signature, cookie, session token, full URL, or unnecessary PII is stored or exposed in UI, logs, support views, or launch artifacts.
- [ ] Terms, privacy, refund policy, guest data handling, payment, payout, shipping, and support expectations are linked or explained where needed (baseline: PR #1509).
- [ ] Checkout meets the launch performance budgets for Buy Now, cart checkout entry, sell-list entry, checkout render, and slow/degraded recovery (baseline: PR #1303).
- [ ] The checkout kill switch blocks entry with customer-safe unavailable/recovery states and never restores dense checkout or old payload paths (baseline: PR #1542).
- [ ] Legacy dense checkout routes, UI, copy, old links, old session payloads, stale fixtures/read models, and provider sandbox leftovers cannot make launch checkout succeed (baseline: PR #1535).
