# Checkout Performance Budgets

This document defines the #1123 performance gate for Milestone #17. It covers the Shopify-simple Buy Cart, Sell List, readiness, checkout, confirmation, account-history handoff, support lookup, and recovery surfaces.

These are launch acceptance budgets, not provider SLAs. A flow passes only when it reaches a known Checkout-owned visible state inside budget and records side-effect status. Fast generic platform errors, stale selectors, missing diagnostic fields, or ambiguous no-state renders fail this gate.

The executable contract lives in `bounded-contexts/checkout/features/sessions/api/checkout-performance-budgets.ts`.

## Ownership

Checkout owns the budget for:

- Buy Cart and Sell List review rendering.
- Buy Cart readiness and Sell List readiness evaluation.
- Optional fulfillment optimization before checkout.
- Checkout entry from Buy Now, Buy Cart readiness, and Sell List readiness.
- Active checkout reload and final confirmation visibility.
- Checkout-owned permanent or temporary recovery states.

Downstream contexts own their committed facts:

- Payments owns charges, payment detail, refunds, and provider money state.
- Ordering owns orders and committed buyer commerce facts.
- Fulfillment owns shipments, labels, tracking, and label cancellation facts.
- Settlement owns payouts, payout holds, reversals, and ledger truth.
- Notifications owns transactional communication delivery.
- Support owns operator recovery workflows and support-safe lookup behavior.

Checkout launch evidence may measure those downstream handoffs, but Checkout must not synthesize downstream completion to satisfy a performance budget.

## Budget Rules

- Every surface must define p95 and timeout ceilings.
- Every timeout must leave headroom below the platform gateway timeout.
- Every surface must name a known visible state.
- Ambiguous no-state render is always a failure.
- Local, staging, and production-like evidence are required.
- Pre-confirmation surfaces must prove payment, order, label, payout, settlement, notification, account-history, and support side effects were not attempted.
- Launch evidence must report Buy Now, Buy Cart readiness, and Sell List readiness separately for guest and signed-in actors.
- Mobile evidence must cover sticky totals/actions, collapsible summaries, saved-row editing, no horizontal overflow, and no layout shift.

## Launch-Supported Shape

The launch budget supports:

- up to 50 cart or Sell List lines;
- up to 8 fulfillment or seller groups;
- up to 80 summary, support, account-history, or recovery rows.

Larger shapes require a new budget review before launch enablement.

## Performance Budget Matrix

| Surface | p95 | Timeout | Visible state | Evidence |
| --- | ---: | ---: | --- | --- |
| Cart/list initial render | 900 ms | 3,000 ms | cart-or-list-review-visible | route, e2e, mobile, metrics |
| Buy Cart readiness evaluation | 1,250 ms | 5,000 ms | readiness-decision-visible | unit, route, e2e, metrics |
| Sell List readiness evaluation | 1,500 ms | 5,000 ms | readiness-decision-visible | unit, route, e2e, metrics |
| Fulfillment optimization decision | 1,500 ms | 5,000 ms | readiness-decision-visible | route, e2e, mobile, metrics |
| Checkout entry review render | 2,500 ms | 8,000 ms | checkout-review-visible | route, e2e, canary, metrics |
| Checkout entry temporary recovery | 3,000 ms | 8,000 ms | checkout-temporary-recovery-visible | route, e2e, canary, metrics |
| Checkout entry permanent recovery | 1,500 ms | 5,000 ms | checkout-permanent-recovery-visible | route, e2e, mobile, a11y |
| Active session reload | 2,000 ms | 8,000 ms | checkout-review-visible or checkout-permanent-recovery-visible | route, e2e, metrics |
| Totals refresh | 2,000 ms | 8,000 ms | checkout-review-visible or checkout-permanent-recovery-visible | route, e2e, mobile, metrics |
| Payment/payout setup handoff | 2,500 ms | 10,000 ms | payment-or-payout-handoff-visible or checkout-permanent-recovery-visible | route, e2e, metrics |
| Final confirmation visible state | 3,500 ms | 12,000 ms | confirmation-visible or checkout-permanent-recovery-visible | route, e2e, mobile, a11y, metrics |
| Provider-return confirmation | 3,000 ms | 12,000 ms | confirmation-visible, checkout-permanent-recovery-visible, or support-safe-status-visible | route, e2e, metrics, runbook |
| Account-history handoff | 2,500 ms | 10,000 ms | account-history-handoff-visible or support-safe-status-visible | route, e2e, mobile, metrics |
| Support lookup | 2,000 ms | 8,000 ms | support-safe-status-visible | route, e2e, metrics, runbook |
| Reversal/recovery status refresh | 2,500 ms | 10,000 ms | reversal-or-recovery-status-visible or support-safe-status-visible | route, e2e, metrics, runbook |
| Mobile sticky action interaction | 200 ms | 1,000 ms | cart/list, checkout, confirmation, or recovery visible | mobile, a11y, e2e |

## Checkout Entry Freshness

Checkout entry evidence measures time to first known Checkout-owned state:

- checkout review visible;
- temporary checkout-preparing recovery visible;
- customer-safe permanent recovery visible.

The PR #1212 staging Buy Now baseline reached safe temporary recovery in 2,937 ms. That value is tracking evidence, not a universal SLA. Current-main launch evidence must remeasure or explicitly revalidate Buy Now, Buy Cart readiness, and Sell List readiness after projection, work-signal, runtime, or sell-confirmation changes.

Temporary recovery counts as safe only when:

- a valid fresh-write handoff exists;
- platform error UI is absent;
- permanent not-found UI is absent;
- payment, order, label, payout, settlement, notification, account-history, and support side effects are not attempted;
- the state wait outcome is diagnostic, not ambiguous.

## Readiness And Optimization

Readiness and optional optimization stay before checkout:

- Buy Cart readiness handles unassigned fulfillment, unavailable supply, save-for-later, and accepted or declined lower-cost fulfillment.
- Sell List readiness handles selected offers, Smart Match offers, fallback listing decisions, payout readiness, ship-from, label/serviceability, item eligibility, and stale seller terms.
- Checkout can display the accepted readiness outcome and route stale states back, but it must not run allocation, optimization, sale-action selection, payout repair, or provider diagnostics inside checkout.

## Confirmation And Downstream Handoff

Final confirmation budgets start only after explicit customer confirmation with current readiness and freshness evidence.

Launch evidence must distinguish:

- confirmation recorded;
- Marketplace handoff recorded;
- payment or payout setup visible;
- downstream order, label, payout, settlement, notification, account-history, support, reversal, or recovery pending;
- downstream committed;
- downstream failed, recovered, held, reversed, or deferred.

Pending downstream state cannot be counted as completed downstream work.

## Evidence Requirements

Each launch evidence row must record:

- entry source: Buy Now, Buy Cart readiness, or Sell List readiness;
- actor: guest or signed-in;
- readiness source revision and snapshot version;
- visible state and latency;
- side-effect status;
- support-safe reference where one exists;
- observability event or metric source;
- no-compatibility scan result;
- current-main PR, test, deploy, canary, or runbook evidence.

Production-like evidence can be synthetic only when it has an approved cleanup or isolation contract. Otherwise staging browser evidence remains the symptom-level proof for customer-visible freshness behavior.

## Failure Rules

The performance gate fails when:

- a generic platform error appears before Checkout-owned recovery;
- the page renders no recognizable state inside the budget;
- a stale selector hides a real state from the canary;
- a missing receipt, missing ownership, stale readiness, old payload, disabled capability, or kill switch adapts into checkout instead of failing closed;
- polling duplicates or outlives the original fresh-write receipt;
- pre-confirmation recovery starts payment, order, label, payout, settlement, notification, account-history, or support side effects;
- mobile sticky actions or summaries become unresponsive, shift layout, or overflow horizontally.
