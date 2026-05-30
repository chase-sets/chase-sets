# Self-Service Purchase Cancellation

Ordering owns buyer self-service purchase cancellation because the Order is the commercial commitment between the buyer account and seller account.

## Policy

Self-service cancellation is a V1 correction path for buyer mistakes after payment. Buyers do not edit committed order terms. Instead, they cancel the purchase while the cancellation window is open and create a new purchase with corrected item, quantity, shipping, or address details.

The cancellation window is open only when all of these facts are true:

- The purchase belongs to the buyer account requesting cancellation.
- The order is `ready-for-fulfillment`.
- Fulfillment has created a shipment for the order and that shipment is still `awaiting-package`.
- No open cancellation or refund effect has already claimed the same order cancellation.

The window closes when Fulfillment records packing start. After that cutoff, the buyer uses the Support-owned `buyer-cancel-request` flow so seller effort, postage, exceptions, and refund decisions are handled through an auditable workflow.

## Context Responsibilities

Ordering records the order cancellation and publishes the cancellation fact. The event remains a fact, not a command to Fulfillment or Payments.

Fulfillment consumes the order cancellation and cancels any shipment still in `awaiting-package`. Fulfillment rejects shipment cancellation after packing starts because fulfillment work has started.

Payments consumes the order cancellation only when a captured payment exists. It issues an idempotent refund for the buyer-paid share: the order total plus the order's allocated Marketplace Checkout Fee.

Support remains the fallback owner after the cancellation window closes. Support may resolve a `buyer-cancel-request` with cancellation, refund, no action, or support review according to its flow catalog.

## Read Model And UI

The buyer purchase read model should expose whether self-service cancellation is available and why it is not available. The purchase detail UI should show the direct cancel action only during the window and otherwise route the buyer to Support.

Use natural buyer-facing language:

- `Cancel purchase` while the window is open.
- `Ask to cancel` or `Open support` after fulfillment work has started.

Avoid language that suggests the buyer can edit a committed order.
