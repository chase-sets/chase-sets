# Marketplace Checkout Fee Policy

Payments owns the buyer-side Marketplace Checkout Fee. The fee is quoted before payment, confirmed with a fingerprint, calculated at payment level after platform credit, and stored as a payment snapshot.

## Current State

- Commercial Terms owns seller-side marketplace sales fee policy only.
- Marketplace owns seller confirmation for listing and accepted-offer fee snapshots.
- Ordering consumes Marketplace snapshots and does not call Commercial Terms for normal listing purchases.
- Ordering stores item subtotal, shipping, sales tax, Marketplace Sales Fee economics, and seller net totals.
- Payments quotes Marketplace Checkout Fee options for card, bank account, and platform-credit-only payments.
- Payments requires a fresh Marketplace Checkout Fee quote fingerprint before payment creation.
- Payments stores Marketplace Checkout Fee amount, policy version, quote fingerprint, and payment method category on the payment snapshot.

## Policy

- Card: 2.9% plus $0.30, grossed up against the external payment amount.
- Bank account: 0.5% plus $0.00 after the bank adjustment.
- Platform-credit-only: $0.00.
- Unsupported or unknown methods default to no positive Marketplace Checkout Fee in the current US-only V1 policy.
- Positive fractional cents round up; exact zero remains zero.

## Cancellation Refunds

When Ordering records buyer self-service cancellation for a captured purchase, Payments refunds the buyer-paid share for the cancelled order. The buyer-paid share includes the order total plus the order's allocated Marketplace Checkout Fee.

Cancellation refund effects must be idempotent across event replay and provider retry. Payments owns the processor-facing refund reference and refund status; Ordering and Fulfillment publish only cancellation and shipment facts.

## Launch Review

Before marketplace production promotion, counsel/provider review must approve final buyer-facing copy, fee labels, refund handling language, state-specific disclosure requirements, and the Stripe live-mode provider posture. Carry that approval through `PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED=true` and a non-empty `PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE` in the production GitHub Environment. The reference must point to the Payments-owned approval record and match the redacted [Marketplace Launch Evidence](../../../docs/runbooks/marketplace-launch-evidence.md) packet. Public Presence may describe the intended model during prelaunch, but live checkout must not open until approved terms are published, Marketplace Checkout Fee evidence is present, and the production marketplace gate is explicitly enabled.

Build the redacted launch-packet gate from the Payments-owned approval record instead of hand-editing `gates.marketplaceCheckoutFee`. The approval record must include `approvalCompletedAt`; rerun the fee, refund-language, disclosure, and live Stripe configuration review when the approval is older than 30 days at launch review:

```powershell
pnpm run marketplace:checkout-fee-evidence -- --approval .\secure\marketplace-checkout-fee-2026-05-30.json --reference PAYMENTS-FEE-2026-05-30
```

The command fails unless the approval is production-scoped, current, uses Stripe live mode, includes the live `/api/marketplace/account/marketplace-checkout-fee-policy` endpoint URL on a production Chase Sets host, records an HTTP `200` endpoint observation timestamp, includes the endpoint evidence reference, carries the current live policy snapshot (`marketplace-checkout-fee-v1`, US-only launch, card/base 2.9% plus $0.30, bank account 0.5% plus $0.00, platform credit $0.00, and `409 fee_quote_stale` confirmation behavior), includes references for buyer-facing copy, fee labels, refund language, state disclosure review, and Stripe live fee configuration, and approves every required Marketplace Checkout Fee launch proof.
