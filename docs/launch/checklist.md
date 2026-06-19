# Chase Sets Checkout Safety Checklist

**Purpose:** Customer-safety checklist for enabling the Shopify-simple Buy Cart and Sell List checkout publicly.

**Principles:** Chase Sets has not launched, so checkout ships as a fresh flow. Do not build migration paths, dense-checkout fallbacks, old session adapters, stale fixture support, dual writes, customer-facing compatibility layers, or helper-only checkout paths. Keep verification practical: focused tests, PR references, production-like smoke, and provider checks are enough when they cover the actual risk.

**Use:** Walk this once before public enablement, and revisit only rows whose product code or provider surface changed.

## Buy Flows

- [ ] Guest buy: cart review -> checkout -> payment -> confirmation completes with no account required (covered by PR #1549).
- [ ] Signed-in buy: saved contact, address, and payment rows render, are editable, and checkout completes (covered by PR #1550).
- [ ] Buy Now works for guest and signed-in buyers, landing on checkout review or checkout-owned preparing recovery instead of a blank/platform/old-checkout page (covered by PR #1212 and PR #1599).
- [ ] A multi-seller cart still presents one payment action and one confirmation; group details remain available afterward for account history and support.
- [ ] Reload, back/forward, and duplicate pay actions never create duplicate payments or orders (covered by PR #1499).

## Sell Flows

- [ ] Signed-in sell: list review -> readiness -> checkout -> explicit confirmation records the pending sale handoff (covered by PR #1289).
- [ ] Guest sell is registration-first: anonymous sellers can prepare a Sell List, but seller checkout requires registration before seller-committing side effects (covered by PR #1497).
- [ ] Sell blockers such as item eligibility, condition, ship-from, label, payout setup, and fallback-listing choice are resolved in Sell List, registration, or onboarding, not checkout (covered by PR #1497).
- [ ] Stale or blocked sell readiness fails closed back to Sell List recovery with no listing, sale, label, payout, settlement, notification, or account-history side effects (covered by PR #1300).

## Entry And Readiness

- [ ] Checkout starts only from a fresh readiness snapshot with ownership/fresh-write evidence; missing, stale, partial, or old-shaped state fails closed to cart/list recovery (covered by PR #1193, PR #1202, and PR #1598).
- [ ] Items without fulfillment assignment stay out of checkout and are resolved in cart, Sell List, or a conditional pre-checkout step (covered by PR #1193, PR #1456, and PR #1598).
- [ ] Optional fulfillment savings is offered before checkout, and accepted or declined decisions carry into checkout as readiness evidence (covered by PR #1495 and PR #1598).
- [ ] Active checkout sessions revalidate readiness, prices, address/serviceability, risk, and provider state before confirmation; stale sessions recover without side effects (covered by PR #1453, PR #1454, PR #1455, PR #1458, and PR #1485).

## Confirmation And Handoff

- [ ] Confirmation shows totals and a support-safe reference for buy and sell (covered by PR #1528).
- [ ] Buyer order history and seller pending activity show the right pending or committed state without pretending downstream owner facts already exist (covered by PR #1296 and PR #1504).
- [ ] No money, order, label, payout, settlement, notification, account-history, refund, void, or reversal side effect starts before explicit final confirmation (covered by PR #1453, PR #1454, PR #1455, PR #1456, PR #1458, and PR #1485).
- [x] Support can look up pending and committed checkout states by support-safe reference (covered by PR #1605).

## Payments, Providers, And Recovery

- [ ] Stripe production-mode payment succeeds, and declined-card recovery leaves no partial order.
- [ ] Stripe webhook replays and payment retries do not duplicate charges, orders, labels, payouts, or notifications (covered by PR #1499).
- [ ] Final confirmation requires the normal payment quote path before order creation or payment handoff.
- [ ] Refund, void, label cancellation, payout hold/reversal, and operator recovery either work through owned actions or are disabled in code with customer-safe support copy (covered by PR #1449).
- [ ] EasyPost production mode and label purchase are verified before enabling label purchase; otherwise label purchase remains disabled with safe copy (covered by PR #1541).
- [ ] Magic provider production imports/promotions remain disabled until MTGJSON, Scryfall, and TCGplayer evidence satisfies `bounded-contexts/catalog/docs/catalog-integration-magic-production-signoff.md`: provider authority approval, interface-only staging UAT, dry-run evidence, option-query freshness/cache-only/stale evidence, job lag/failure monitoring, blocked promotion/conflict/duplicate-prevention review, single-provider stop proof, emergency-stop proof, and redaction review.

## Notifications, Support, And Observability

- [ ] Buyer and seller transactional notifications send only from the owning committed facts and include correct totals/support references where customer-visible.
- [ ] Notification failure does not block checkout completion, and retries suppress duplicates.
- [ ] Checkout entry, recovery, confirmation, provider-return, failure, and no-side-effect states emit redacted observability signals usable by support.
- [ ] Account cart post-write consistency evidence uses the redacted canary artifact, covers optimistic apply, reconciliation, stale-response discard, and rollback/freshness outcomes, and keeps `missing_strategy` plus `freshness_timeout` telemetry at zero once runtime emission is live (see `docs/runbooks/account-cart-consistency-canary.md`).
- [x] Support runbooks cover stuck checkout, payment dispute, missing/failed downstream handoff, and refund requests (covered by PR #1513 and PR #1606).

## Security, Performance, And Fresh State

- [ ] No raw card, bank, provider secret, webhook signature, cookie, session token, full URL, or unnecessary PII is stored or exposed in UI, logs, support views, or operational artifacts.
- [ ] Post-write consistency evidence and telemetry contain only structural labels, route templates, context/surface names, outcome codes, durations, and private evidence references; account ids, cart ids, checkout session ids, event ids, raw `afterWrite`, emails, cookies, tokens, full URLs, item details, provider payloads, and screenshots containing those values stay out of launch artifacts.
- [ ] Terms, privacy, refund policy, guest data handling, payment, payout, shipping, and support expectations are linked or explained where needed (covered by PR #1509).
- [ ] Checkout meets the performance budgets for Buy Now, cart checkout entry, sell-list entry, checkout render, and slow/degraded recovery (covered by PR #1303).
- [ ] Checkout availability is governed by fresh route, readiness, ownership, and current-fact validation with no rollout switch or dense checkout fallback.
- [ ] Legacy dense checkout routes, UI, copy, old links, old session payloads, stale fixtures/read models, and provider sandbox leftovers cannot make new checkout succeed (covered by PR #1535).
