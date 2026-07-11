# Marketplace Checkout Fee Policy

Payments owns the buyer-side Marketplace Checkout Fee. The fee is quoted before payment, confirmed with a fingerprint, calculated at payment level after platform credit, and stored as a payment snapshot.

## Current State

- Commercial Terms owns the checkout processing-fee *policy* (base bps/fixed terms, per-payment-method-category adjustments, enabled jurisdictions) as a runtime-configurable, admin-managed `@chase-sets/platform-policy` document (`commercial-terms.checkout-processing-fee`). Commercial Terms owns seller-side marketplace sales fee policy as before.
- Payments owns the checkout processing-fee *quote math*, the fingerprint/staleness flow, and payment processor state; it resolves the current policy value at quote time via the `checkoutProcessingFeePolicyResolver` host port (provided by Commercial Terms) rather than compiling the values. The compiled launch values are the fallback used only when no policy document is active.
- Marketplace owns seller confirmation for listing and accepted-offer fee snapshots.
- Ordering consumes Marketplace snapshots and does not call Commercial Terms for normal listing purchases.
- Ordering stores item subtotal, shipping, sales tax, Marketplace Sales Fee economics, and seller net totals.
- Payments quotes Marketplace Checkout Fee options for card, bank account, and platform-credit-only payments.
- Payments requires a fresh Marketplace Checkout Fee quote fingerprint before payment creation. A policy revision changes the fee amount (and therefore the fingerprint) embedded in the next quote, so an in-flight revision surfaces through the same `409 fee_quote_stale` re-quote flow as any other amount change -- no separate staleness mechanism was added for policy changes.
- Payments stores Marketplace Checkout Fee amount, policy version, quote fingerprint, and payment method category on the payment snapshot. `policy_version` identifies the quote-fingerprint *format* (`marketplace-checkout-fee-v1`) and stays fixed across policy revisions; the specific values in effect for a given quote are captured by the amounts already embedded in the fingerprint, not by a second version counter.

## Policy

- Card: 2.9% plus $0.30, grossed up against the external payment amount.
- Bank account: 0.5% plus $0.00 after the bank adjustment.
- Platform-credit-only: $0.00.
- Unsupported or unknown methods default to no positive Marketplace Checkout Fee in the current US-only V1 policy.
- Positive fractional cents round up; exact zero remains zero.
- These are the launch values, seeded into Commercial Terms' checkout processing-fee policy document and used as Payments' compiled fallback. An operator can revise them going forward through the Commercial Terms admin API (`/api/commercial-terms/checkout-processing-fee`); a JSON API exists today, and an admin-web UI page under the existing `/terms` section is tracked as follow-up work (not required for this migration's behavior-preservation scope).

## Marketplace Sales Fee Lock Interaction (m105)

The seller-side Marketplace Sales Fee lock (m105) and the buyer-side checkout processing-fee policy are architecturally independent and this migration does not change that:

- A fee-locked listing's Marketplace Sales Fee is resolved and snapshotted by Commercial Terms/Marketplace at listing (or offer-acceptance) time and flows into Ordering's order snapshot unchanged; Payments only sums the already-locked `marketplace_sales_fee_amount` off the order rows (see `sumFeeAmounts(orders, "marketplace_sales_fee_amount")` in `features/payments/api/runtime.ts`).
- The checkout processing fee is never part of the fee lock's scope: it is always resolved fresh, at payment time, from whatever checkout processing-fee policy is currently active -- exactly as it was when the values were compiled constants.
- A locked listing therefore keeps its locked Marketplace Sales Fee for the life of the lock; a checkout processing-fee policy revision changes only the processing fee on payments created after the revision (fresh quotes), on both locked and unlocked listings alike, subject to the usual quote-fingerprint staleness check for any payment already mid-session.

## Cancellation Refunds

When Ordering records buyer self-service cancellation for a captured purchase, Payments refunds the buyer-paid share for the cancelled order. The buyer-paid share includes the order total plus the order's allocated Marketplace Checkout Fee.

Cancellation refund effects must be idempotent across event replay and provider retry. Payments owns the processor-facing refund reference and refund status; Ordering and Fulfillment publish only cancellation and shipment facts.

## Launch Review

Before marketplace production promotion, counsel/provider review must approve final buyer-facing copy, fee labels, refund handling language, state-specific disclosure requirements, and the Stripe live-mode provider posture. Carry that approval through `PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED=true` and a non-empty `PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE` in the production GitHub Environment. The reference must point to the Payments-owned approval record. Public Presence may describe the intended model during prelaunch, but live checkout must not open until approved terms are published, Marketplace Checkout Fee approval is present, and the production marketplace gate is explicitly enabled.

Build the redacted Marketplace Checkout Fee approval from the Payments-owned record instead of hand-editing production variables. The approval record must include `approvalCompletedAt`; rerun the fee, refund-language, disclosure, and live Stripe configuration review when the approval is older than 30 days at launch review:

```powershell
pnpm run ops marketplace:checkout-fee-evidence --approval .\secure\marketplace-checkout-fee-2026-05-30.json --reference PAYMENTS-FEE-2026-05-30
```

The command fails unless the approval is production-scoped, current, uses Stripe live mode, includes the live `/api/marketplace/account/marketplace-checkout-fee-policy` endpoint URL on a production Chase Sets host, records an HTTP `200` endpoint observation timestamp, includes the endpoint evidence reference, carries the current live policy snapshot (`marketplace-checkout-fee-v1`, US-only launch, card/base 2.9% plus $0.30, bank account 0.5% plus $0.00, platform credit $0.00, and `409 fee_quote_stale` confirmation behavior), includes references for buyer-facing copy, fee labels, refund language, state disclosure review, and Stripe live fee configuration, and approves every required Marketplace Checkout Fee launch proof.
