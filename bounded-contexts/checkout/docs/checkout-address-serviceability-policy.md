# Checkout Address And Serviceability Policy

This document defines the #1127 address validation, delivery eligibility,
serviceability, shipping restriction, and quote-readiness policy for Milestone
#17. The executable contract lives in
`bounded-contexts/checkout/features/sessions/api/checkout-address-serviceability-policy.ts`.

Address handling stays simple: buyers correct delivery details in checkout or
return to readiness, sellers resolve ship-from blockers in Sell List readiness,
and provider-dependent address failures use customer-safe recovery. Checkout
does not hide address repair, translate old payloads, or continue with stale
shipping, tax, label, payout, split-group, or risk facts.

## Launch Rules

- Buyer delivery addresses require required-field validation, normalized
  evidence when a provider is used, serviceability decision, freshness key, and
  support-safe failure code before payment or order creation.
- Seller ship-from facts stay in Sell List readiness until Fulfillment,
  Settlement, Identity, Payments, and Marketplace dependencies are ready.
- Shipping, tax, payout, label, split-group, and risk provider calls run only
  after the address is sufficient for that provider and are rejected when the
  serviceability decision is stale.
- Manual edits, saved-row edits, wallet or express return, account update,
  provider normalization, guest merge, active return, reload, duplicate submit,
  and final confirmation revalidate address-dependent facts before side effects.
- Invalid, restricted, unserviceable, quote-unavailable, provider-outage,
  disabled, deferred, unsupported, and stale address states use #1102 copy,
  #1112 visuals, #1114 observability, #1115 coverage, #1122 support path, and
  #1116 launch-register rows where launch-visible.
- Address blocks must prove no payment, order, sale, label, payout,
  fulfillment, settlement, notification, support, account-history, refund, void,
  or reversal side effect started.
- Fresh-state cleanup must prove address handling cannot succeed through old
  checkout payloads, hidden normalization, migration/backfill helpers, stale read
  models, stale fixtures, provider-dashboard-only recovery, or dense checkout
  fallback.

## Control Inventory

| Control | Owner | Checkpoints | Quote dependencies | Launch decision | Surface | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Buyer delivery address validation | Checkout | manual-address-edit, checkout-session-create, final-confirmation | shipping-quote, tax-quote, risk-check | required-for-launch | checkout-form | Guest and signed-in buyers cannot proceed to payment or order creation until required delivery fields, normalized evidence, serviceability, quote readiness, and risk dependencies are current. |
| Seller ship-from address validation | Fulfillment | cart-list-readiness, manual-address-edit, final-confirmation | label-service, payout-quote, risk-check | required-for-launch | cart-list-readiness | Guest and signed-in sellers cannot confirm label, payout, settlement, notification, or account-history work when ship-from facts are missing, stale, restricted, or unserviceable. |
| Saved address invalidation | Identity | saved-row-edit, account-update, active-session-return, final-confirmation | shipping-quote, tax-quote, payout-quote, label-service, risk-check | required-for-launch | checkout-recovery | Saved addresses that are edited, revoked, normalized differently, or made unsupported fall back to editable rows and invalidate dependent quotes before confirmation. |
| Address normalization provider evidence | Fulfillment | manual-address-edit, wallet-or-express-return, final-confirmation | shipping-quote, tax-quote, label-service | launch-register-required | provider-return-recovery | Provider normalization records provider/version evidence and support-safe failure codes without hidden normalization or provider payload exposure. |
| Unsupported country, region, or postal code | Fulfillment | cart-list-readiness, manual-address-edit, final-confirmation | shipping-quote, tax-quote, payout-quote, label-service | launch-register-required | checkout-recovery | Unsupported country, region, and postal outcomes show simple recovery or return-to-list/cart guidance before any payment, order, label, payout, or fulfillment side effect starts. |
| PO box or restricted address | Fulfillment | manual-address-edit, final-confirmation | shipping-quote, tax-quote, risk-check | launch-register-required | checkout-form | PO box and restricted-address outcomes block unavailable shipping services with customer-safe copy and no raw carrier/provider diagnostics. |
| Military, remote, or special destination | Fulfillment | cart-list-readiness, manual-address-edit, final-confirmation | shipping-quote, tax-quote, split-group-promise, risk-check | launch-register-required | checkout-recovery | Military, remote, and special destination rules are explicit launch states, not implicit carrier failures discovered after payment or label work starts. |
| Serviceability before provider quotes | Checkout | manual-address-edit, checkout-session-create, final-confirmation | shipping-quote, tax-quote, payout-quote, label-service, risk-check | required-for-launch | checkout-form | Shipping, tax, payout, label, split-group, and risk provider calls run only after the address is sufficient for that provider and are rejected when the serviceability decision is stale. |
| Quote refresh after address change | Checkout | manual-address-edit, saved-row-edit, wallet-or-express-return, final-confirmation | shipping-quote, tax-quote, payout-quote, label-service, split-group-promise | required-for-launch | checkout-recovery | Manual edits, saved-row edits, wallet returns, and provider normalization changes invalidate address-dependent quote fingerprints before final confirmation. |
| Wallet or express address return | Payments | wallet-or-express-return, active-session-return, final-confirmation | shipping-quote, tax-quote, risk-check | launch-register-required | provider-return-recovery | Wallet or express-return addresses re-enter the same serviceability and quote gates; unsupported changes return to simple correction instead of continuing with stale totals. |
| Active-session address revalidation | Checkout | active-session-return, duplicate-submit, final-confirmation | shipping-quote, tax-quote, payout-quote, label-service, risk-check | required-for-launch | checkout-recovery | Active sessions revalidate address and dependent provider facts on return, reload, duplicate submit, and final confirmation before any customer-committing side effect starts. |
| Split-group shipping promise | Fulfillment | cart-list-readiness, manual-address-edit, final-confirmation | shipping-quote, split-group-promise, risk-check | launch-register-required | cart-list-readiness | Split-group shipping promises are produced by readiness and consumed by checkout; address changes route back to readiness instead of regrouping shipments in checkout. |
| Quote unavailable or provider outage | Platform | manual-address-edit, wallet-or-express-return, final-confirmation, operator-support | shipping-quote, tax-quote, payout-quote, label-service, risk-check | launch-register-required | launch-evidence | Quote-unavailable, provider-outage, disabled, deferred, and unsupported address states have owner, copy, visual, support, observability, expiry/follow-up, and launch-register evidence. |
| Support-safe address failure | Support | operator-support | shipping-quote, tax-quote, payout-quote, label-service, risk-check | required-for-launch | support-runbook | Support can see masked address failure category, owner, freshness status, and support-safe reference without full address, raw provider payload, or manual repair instructions. |
| No-side-effect address blocks | Checkout | checkout-session-create, active-session-return, final-confirmation | shipping-quote, tax-quote, payout-quote, label-service, split-group-promise, risk-check | required-for-launch | checkout-recovery | Address blocks prove no payment, order, sale, label, payout, fulfillment, settlement, notification, support, account-history, refund, void, or reversal side effect started. |
| Fresh-state address cleanup | Platform | checkout-session-create, active-session-return, final-confirmation, operator-support | none | required-for-launch | launch-evidence | Fresh-state scans prove address handling cannot succeed through old payloads, hidden normalization, migration/backfill helpers, stale read models, stale fixtures, or dense checkout fallback. |

## Evidence Required Before #1127 Closes

- Current-main or staging evidence for guest and signed-in buyer delivery
  validation, seller ship-from validation, malformed address, unsupported
  destination, PO box or restricted address, saved-address invalidation,
  wallet/express address return where enabled, quote unavailable, provider
  outage, customer correction, and support lookup.
- Provider/version evidence, normalized address freshness keys, serviceability
  decision, quote fingerprint, and support-safe failure code for any provider
  assisted validation or quote path.
- #1116 launch-register rows for invalid, restricted, unserviceable,
  quote-unavailable, provider-outage, disabled, deferred, unsupported, and stale
  launch-visible states.
- #1102 copy and #1112 visual mappings for correction, provider return,
  quote-unavailable, support, and no-side-effect recovery states.
- #1114 observability proving category-only telemetry, support-safe references,
  freshness status, launch-register decision, and no full address or raw provider
  payload exposure.
- Fresh-state scans proving old checkout payloads, hidden normalization,
  migration/backfill helpers, stale read models, stale fixtures,
  provider-dashboard-only recovery, and dense checkout fallback cannot satisfy
  address or serviceability checks.
