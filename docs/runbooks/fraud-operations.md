# Fraud Operations

This runbook records operator policy for fraud and trust-safety controls that cross account, marketplace, payments, and settlement behavior.

## Velocity Alerts

Risk velocity alerts are operator-only in v1. They do not automatically hold payouts, suspend accounts, unlist content, block checkout, or refund payments.

| Flag | Default threshold | Manual response |
| --- | --- | --- |
| Chargeback velocity | 2 or more seller chargebacks in 30 days, or chargeback rate at least 2% over seller payments in 30 days | Review payment and dispute timelines, confirm seller exposure, and request the Identity `manual-payout-review` badge when the evidence supports enhanced payout release holds. |
| New seller listing velocity | Account age under 30 days and listing asking value at least $2,500 in 24 hours | Inspect listings for high-value concentration, duplicate/counterfeit signals, payout readiness, and recent reports before contacting the account. |
| Review velocity | 5 or more reviews received in 24 hours with median reviewer account age under 7 days | Check purchase-gated review eligibility, account relationships, and support/report history before removing reviews or escalating account action. |
| Young buyer spend velocity | Buyer account age under 7 days and payment-created spend at least $2,000 in 24 hours | Review payment risk timeline, order concentration, fulfillment status, and Stripe risk signals before contacting the buyer or opening support follow-up. |

## Payment Fraud Signals

Payments is the source of truth for processor fraud signals.

- Early fraud warnings are recorded on the Payment with the provider event id, warning id, charge reference, processor status, fraud type, charge-disputed flag, and received timestamp.
- When an early fraud warning arrives for a captured or partially refunded payment that is not already disputed, Payments attempts to refund the remaining refundable amount when the refund service is configured.
- Processor fraud reviews are recorded when opened and closed. Consumer contexts may use those facts to pause dependent workflows, but they must not reinterpret the processor signal.
- 3DS requests are risk-based. Payments records the requested 3DS mode, reason codes, and processor liability-shift outcome. Liability-shift facts inform payment risk and dispute posture; they do not bypass Settlement payout-release holds.

Operator response:

- Review the Payment timeline first. Confirm whether the processor signal is an early fraud warning, an open fraud review, a closed review, or a formal dispute.
- Do not promise an automatic buyer or seller outcome from the signal alone. Check refund state, dispute state, shipment state, and wallet exposure before communicating a resolution.
- If an early fraud warning did not trigger a refund because the charge is already disputed, no refund service is configured, or no refundable amount remains, document the reason in the support case.

## Chargebacks and Dispute Evidence

Payments records processor disputes and owns dispute evidence submission. Settlement owns seller exposure in Wallet.

- A processor dispute records the provider dispute id, lifecycle state, evidence deadline, charge reference, affected orders, dispute reason, dispute amount, and seller payout exposure.
- Settlement consumes the dispute fact to hold pending seller funds, claw back released seller exposure, or release a chargeback hold when the processor dispute is won.
- Payments assembles evidence from Payments order inputs and the Payments-owned Fulfillment evidence projection.
- Evidence submission requires tracking proof. When no tracking proof is available, Payments records dispute evidence unavailable with reason `tracking-unavailable`.
- Evidence payloads can include buyer email, shipping name and address, product description, carrier, shipping date, tracking number, and an order/fulfillment narrative assembled from platform records.

Operator response:

- For `created` or `updated` disputes, verify whether evidence was submitted or recorded unavailable.
- If evidence is unavailable, inspect Fulfillment for missing label purchase, missing tracking identifier, untracked letter mail, or projection lag before escalating.
- If the processor dispute is won, confirm Settlement posted the matching dispute release. If it is open or lost, confirm pending holds or clawbacks remain in place.

## Shipping and Return Evidence

Fulfillment owns shipment truth used by Payments and Settlement.

- Package plans carry the committed Shipping Evidence Tier: `letter-untracked`, `tracked-parcel`, `signature-confirmed`, or `carrier-insured`.
- Current postage policy uses untracked letter mail only for eligible low-risk raw-card orders, requires parcel service above the letter declared-value cap, requires signature confirmation for priority shipping or declared value at `250.00 USD` or more, and requires carrier insurance at `500.00 USD` or more.
- Fulfillment records label purchase, carrier, tracking identifier, delivery, return-to-sender, carrier exceptions, label refunds, signature, and insurance facts.
- Returned shipments, fulfillment exceptions, active support holds, manual payout review, untrusted account state, and high-dollar seller exposure can extend or prevent payout release.

Operator response:

- For buyer non-delivery or not-as-described contacts, start with the shipment detail and package plan, then compare tracking and carrier events to the order and payment timeline.
- Treat untracked letter mail as lower evidence, not as proof of delivery.
- For return-to-sender or carrier exception cases, record the support decision against the shipment/order evidence before changing payment or wallet state.

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
