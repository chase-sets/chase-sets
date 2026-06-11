# Checkout Observability Contract

Milestone #17 uses this contract to turn launch-matrix `observability-event` evidence into named, redacted Checkout telemetry. It keeps customer-facing checkout simple while giving support, operations, and launch reviewers enough signal to distinguish readiness, checkout entry, confirmation, downstream handoff, recovery, and cleanup states.

The executable contract lives in `bounded-contexts/checkout/features/sessions/api/checkout-observability-contract.ts`.

## Evidence Rules

- Every launch evidence row has one `checkout.*` observability profile with entry source, actor mode, scenario state, visible state, and side-effect status dimensions.
- Runtime metrics use `chase_sets_checkout_observability_events_total`. Dashboard and alert queries must use the typed profile event names and bounded label values only.
- Unassigned fulfillment and optional savings optimization emit readiness telemetry before checkout. Checkout telemetry may consume the accepted or declined decision, but must not record checkout-time allocation or optimization repair.
- Launch-register rows emit `launch-register-decision` and appear in release health evidence so enabled, disabled, deferred, provider-limited, risk-held, kill-switched, and cleanup states are reviewable.
- Support-visible states emit support-safe references only. No raw `afterWrite`, cookies, emails, addresses, provider payloads, checkout session ids, account ids, event ids, full URLs, card data, bank data, secrets, or sensitive risk signals belong in telemetry, dashboards, launch evidence, or GitHub issue comments.
- Pending downstream rows emit `downstream-status` so confirmation, Marketplace handoff, notification, account history, reconciliation, and reversal states cannot imply completed Ordering, Fulfillment, Settlement, Notifications, Support, or Payments facts before the owning context commits them.
- Fresh-state cleanup telemetry emits `fresh-state-scan-result` and fails the launch evidence if old routes, payload adapters, compatibility shims, hidden repair, migration/backfill helpers, dual writes, stale fixtures, cached read models, provider sandbox leftovers, localization keys, docs, runbooks, canaries, smoke data, or browser artifacts make checkout appear successful.

## Dashboard Contract

Grafana provisions `infrastructure/observability/stack/grafana/dashboards/checkout-launch-observability.json` as the launch dashboard for this contract. It has panels for:

- checkout launch events by telemetry and alert class;
- release-health required rows by launch decision and release run;
- fresh-state, provider, support, and launch alert classes;
- no-side-effect recovery proof;
- pending versus committed downstream handoff boundaries;
- selected event dimensions such as performance budget, canary final state, and promotion decision;
- redacted checkout observability logs from platform services.

Starter alerts live in `infrastructure/observability/stack/grafana/provisioning/alerting/platform-api-alerts.yml` for launch/fresh-state/provider alert events and side-effect boundary violations.

This dashboard is the query and alert baseline. #1114 remains open until runtime emission and staging/launch evidence prove these panels receive redacted events for launch-supported states.

## Required Dimensions

Every profile includes `entry-source`, `actor-mode`, `scenario-state`, `visible-state`, `side-effect-status`, and `support-safe-reference`.

Rows add focused dimensions such as `readiness-contract`, `readiness-snapshot-version`, `source-revision`, `fresh-write-receipt-presence`, `support-safe-reference`, `performance-budget-id`, `latency-ms`, `provider-category`, `risk-category`, `downstream-status`, `launch-register-decision`, `fresh-state-scan-result`, `canary-final-state`, `promotion-decision`, and `release-run-id`.

## Profiles

| State | Event | Class | Alert | Release health | Evidence expectation |
| --- | --- | --- | --- | --- | --- |
| Buy Cart review ready | `checkout.cart.review_ready` | funnel | dashboard-only | No | Cart review telemetry proves mutable intent rendered without checkout repair machinery. |
| Buy readiness attention | `checkout.readiness.unassigned_fulfillment` | readiness | support-alert | Yes | Unassigned fulfillment telemetry stays in readiness and proves no downstream side effects started. |
| Buy readiness savings optimization | `checkout.readiness.optimization_decision` | readiness | dashboard-only | No | Optimization telemetry records accepted or declined savings before checkout entry. |
| Guest Buy Checkout | `checkout.buy.guest_review_rendered` | checkout-entry | dashboard-only | No | Guest buy checkout telemetry proves form-first review rendered from current readiness only. |
| Signed-in Buy Checkout | `checkout.buy.signed_in_review_rendered` | checkout-entry | dashboard-only | No | Signed-in buy telemetry proves saved rows rendered with fresh account facts. |
| Sell List review ready | `checkout.sell_list.review_ready` | funnel | dashboard-only | No | Sell List review telemetry proves seller intent rendered before sale action commitment. |
| Sell List readiness blocked | `checkout.sell_list.readiness_blocked` | readiness | support-alert | Yes | Seller readiness telemetry keeps eligibility, payout, label, and provider blockers before checkout. |
| Guest Sell Checkout | `checkout.sell.guest_review_rendered` | checkout-entry | launch-alert | Yes | Guest sell telemetry records whether seller account or payout setup is enabled, disabled, or deferred. |
| Signed-in Sell Checkout | `checkout.sell.signed_in_review_rendered` | checkout-entry | dashboard-only | No | Signed-in sell telemetry proves provider-ready facts were consumed without rebuilding diagnostics. |
| Seller confirmation activity | `checkout.sell.confirmation_activity_recorded` | confirmation | support-alert | Yes | Seller confirmation telemetry separates recorded handoff from downstream completion. |
| Active-session stale recovery | `checkout.session.active_stale_recovery` | recovery | fresh-state-alert | Yes | Active-session recovery telemetry proves source revalidation failed closed before side effects. |
| Address or serviceability failure | `checkout.address.serviceability_failed` | recovery | support-alert | Yes | Address telemetry proves serviceability failed safely without exposing address contents. |
| Changed economics review | `checkout.economics.changed_review_required` | recovery | support-alert | Yes | Economics telemetry proves changed totals require review before confirmation. |
| Risk hold or provider-return failure | `checkout.provider_or_risk.recovery_required` | recovery | provider-alert | Yes | Provider and risk telemetry gives support-safe status without sensitive provider or risk details. |
| Split package summary | `checkout.buy.split_group_summary_rendered` | checkout-entry | launch-alert | Yes | Split-group telemetry preserves readiness-produced group references without checkout-time regrouping. |
| Checkout unavailable | `checkout.launch.kill_switch_unavailable` | launch-governance | launch-alert | Yes | Kill-switch telemetry proves checkout failed closed without legacy fallback. |
| Temporary recovery loading | `checkout.entry.temporary_recovery_visible` | checkout-entry | fresh-state-alert | Yes | Temporary recovery telemetry distinguishes safe waiting from ambiguous no-state renders. |
| Production proof Buy Now readiness | `checkout.launch.production_proof_buy_now` | launch-governance | launch-alert | Yes | Production proof telemetry records pay-ready success or checkout-ready SLO failure without side effects. |
| Disabled accelerated or saved instrument | `checkout.capability.accelerated_or_saved_disabled` | launch-governance | launch-alert | Yes | Capability telemetry proves shortcuts cannot bypass readiness or final review. |
| Promo, credit, gift card, and fee state | `checkout.capability.promo_credit_gift_card_state` | launch-governance | launch-alert | Yes | Promo and credit telemetry records explicit enabled, disabled, or deferred launch state. |
| Notification expectation and support reference | `checkout.notification.expectation_recorded` | handoff | support-alert | Yes | Notification telemetry records expectation and support reference without implying delivery. |
| Account history handoff | `checkout.account_history.handoff_visible` | handoff | support-alert | Yes | Account-history telemetry links only committed downstream records and support-safe source references. |
| Reconciliation pending | `checkout.reconciliation.pending_visible` | handoff | support-alert | Yes | Reconciliation telemetry distinguishes pending recovery from committed downstream facts. |
| Reversal and adjustment recovery | `checkout.reversal_or_adjustment.status_visible` | handoff | support-alert | Yes | Reversal telemetry is audited, support-safe, and separated from completed refund or payout facts. |
| Fresh-state cleanup absence | `checkout.launch.fresh_state_cleanup_verified` | fresh-state-cleanup | fresh-state-alert | Yes | Cleanup telemetry proves old routes, payloads, shims, fixtures, docs, and runbooks cannot satisfy launch. |

## Launch Consumption

#1114 owns this contract as the observability baseline. #1115 should attach route, E2E, visual, accessibility, and canary artifacts that prove the profiles emit for launch-supported states. #1116 should attach release-health references for rows marked as release-health required. #1122 should consume support-safe references and runbook-safe dimensions. #1124 should review the forbidden field set and any future dimension additions before launch.
