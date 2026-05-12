# Support

Support owns structured marketplace support requests. It keeps buyer and seller workflows inside guided, auditable steps so common issues can be resolved without direct buyer-seller negotiation.

The `support-requests` slice uses a flow catalog for issue-specific requirements. New support flows should add a catalog entry and tests before changing aggregate lifecycle behavior.

Cross-context outcomes stay with the context that owns the consequence:

- Payments listens for refund-producing support resolutions and issues order-scoped refunds.
- Settlement listens for open support requests and keeps seller proceeds on hold so payouts cannot include disputed order funds.
- Reputation removes review eligibility while an order is under support review and restores it only when the outcome does not change the transaction.
- Ordering and Fulfillment remain the source of truth for order and shipment state that support uses to guide available flows.

Buyer cancellation after Fulfillment records package preparation uses the `buyer-cancel-request` flow. Before package preparation, Ordering owns self-service purchase cancellation and Support should not create a parallel workflow.

Refund-style outcomes keep settlement funds held until the money movement and seller-ledger reconciliation have completed. That is intentional for low-value cards: protecting the buyer and avoiding accidental seller payout takes priority over making disputed proceeds available quickly.
