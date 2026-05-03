# Buyer Payment Fee Policy Future Work

Buyer payment fees are intentionally deferred from the permanent listing marketplace fee update.

## Current State

- Commercial Terms owns seller-side marketplace fee policy only.
- Marketplace owns seller confirmation for listing and accepted-offer fee snapshots.
- Ordering consumes Marketplace snapshots and does not call Commercial Terms for normal listing purchases.
- Payments carries a zero-value buyer processing fee placeholder so payment read models remain explicit.

## Future Scope

When buyer payment fee policy is introduced, Payments should own:

- payment processor fee policy and funding-source adjustments
- buyer-visible processing fee previews
- buyer confirmation semantics for processing fees
- payment-level fee snapshots used for capture, refund, reconciliation, and support views

That work must not reintroduce seller-side payment fee fields into Commercial Terms or order-time seller fee resolution into Ordering.
