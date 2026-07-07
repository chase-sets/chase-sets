# Fraud Operations

This runbook records operator policy for fraud and trust-safety controls that cross account, marketplace, payments, and settlement behavior.

## Negative Balance Lifecycle

Settlement owns negative balance truth in the Wallet ledger and lifecycle state. Ledger entries remain immutable; the lifecycle is derived from wallet events.

- `in-good-standing`: available balance is zero or positive.
- `negative`: available balance is below zero. Payout requests are paused. New sales remain allowed because sale proceeds are the primary recovery path.
- `collections`: available balance is negative at or beyond the configured threshold for at least the configured grace period. Marketplace pauses seller listing availability with the platform `operations` reason, and operators review the account from the Settlement negative-balance queue.

Default collections policy:

- Threshold: `100.00 USD`
- Grace period: `14 days`

The threshold and grace period are Settlement runtime configuration (`negativeBalancePolicy`) and should be changed only with Trust & Safety and Finance approval.

Sale-credit recovery:

- New sale proceeds and shipping allowances first offset the negative available balance.
- Only sale-credit amounts remaining after the offset stay pending for normal delivery, support, and risk release.
- Recovery to zero or positive returns the wallet to `in-good-standing` and clears the collections state.

Manual repayment:

- Manual repayment through a Stripe payment against the balance is not part of the current runtime path.
- Until that follow-up exists, operators should direct recovery through continued sales or Finance-approved manual ledger adjustment with audit notes.
