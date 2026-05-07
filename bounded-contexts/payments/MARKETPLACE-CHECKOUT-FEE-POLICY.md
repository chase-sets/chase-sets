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
- Unsupported or unknown methods normalize to the card quote in the current US-only V1 policy.
- Positive fractional cents round up; exact zero remains zero.

## Launch Review

Before launch, counsel/provider review should approve final buyer-facing copy and any state-specific disclosure requirements.
