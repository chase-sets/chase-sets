# Checkout Payment And Payout Affordance Policy

This document defines the #1113 payment, saved payment, accelerated payment,
and payout setup affordance policy for Milestone #17. The executable contract
lives in
`bounded-contexts/checkout/features/sessions/api/checkout-payment-payout-affordance-policy.ts`.

Convenience affordances never skip readiness or final confirmation. They are
shorter ways to present or select current owner facts, not alternate checkout
paths.

## Rules

- Guest buy checkout keeps the card form available without requiring account
  creation.
- Signed-in saved payment and saved payout rows must be masked, current,
  editable, and backed by owning-context readiness.
- Accelerated saved payment can shorten confirmation only after the same
  readiness, economics, risk, provider, and saved-instrument facts are current.
- Guest saved-payment attempts fail before checkout mutations and fall back to
  card payment or sign-in.
- Seller payout setup remains Settlement-owned. Checkout may link to or render
  the handoff, but cannot manufacture payout readiness.
- Provider and payout setup return paths must route to review or recovery before
  any customer-committing side effect.
- Shortcut copy, telemetry, support records, and operator outputs never expose
  raw card data, CVC, bank account data, provider secrets, provider payloads,
  full URLs, emails, addresses, or session tokens.

## Affordance Inventory

| Affordance | Mode | Actor | Owner | Capability | Boundary | Copy surface | Visual target | Customer-safe outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Guest card payment form | buy | guest | Payments | enabled | final-confirmation-only | checkout-review | guest-buy-checkout | Guests can pay through the normal checkout form without account creation or Chase Sets handling raw card data. |
| Signed-in saved payment row | buy | signed-in | Identity | enabled | final-confirmation-only | checkout-saved-info-rows | signed-in-buy-checkout | Signed-in buyers can reuse a masked saved payment row only when current account and provider facts are available. |
| Accelerated saved payment confirmation | buy | signed-in | Payments | enabled | final-confirmation-only | checkout-saved-info-rows | signed-in-buy-checkout | Accelerated saved payment is a shorter confirmation path, not a bypass around readiness, totals, risk, or provider checks. |
| Guest saved payment block | buy | guest | Checkout | disabled | none-before-final-confirmation | accelerated-saved-instrument-fallback | disabled-accelerated-saved-instrument | Guest saved-payment attempts fail before checkout mutations and emit support-safe disabled-capability telemetry. |
| Provider return review | buy | guest, signed-in | Payments | provider-unavailable | none-before-final-confirmation | provider-return-recovery | risk-hold-provider-return-failure | Provider returns require a fresh review before retry and never expose provider payloads or raw payment details. |
| Seller payout setup handoff | sell | guest, signed-in | Settlement | setup-required | owner-managed-handoff-only | accelerated-saved-instrument-fallback | disabled-accelerated-saved-instrument | Payout setup stays Settlement-owned and cannot create sale, label, payout, settlement, or notification work from Checkout alone. |
| Signed-in saved payout row | sell | signed-in | Settlement | enabled | final-confirmation-only | checkout-saved-info-rows | signed-in-sell-checkout | Signed-in sellers see a masked payout row only from current Settlement readiness and must still explicitly confirm. |
| Seller payout setup recovery | sell | guest, signed-in | Settlement | provider-unavailable | none-before-final-confirmation | provider-return-recovery | risk-hold-provider-return-failure | Payout setup failures block seller confirmation without exposing bank data or pretending sale/payout work completed. |

## Remaining #1113 Work

- Wire any future provider-specific accelerated checkout method through the same
  readiness, provider, risk, economics, and confirmation gates.
- Keep provider setup and saved-instrument storage in Payments, Settlement, or
  Identity; Checkout consumes only support-safe owner facts.
- Extend the visual and telemetry surfaces only when a new user-visible state is
  genuinely different from the existing saved-row, fallback, or recovery states.
