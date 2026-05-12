# Purchase Cancellation Cutoff

Fulfillment owns the operational cutoff for buyer self-service purchase cancellation because Shipment state is the source of truth for seller fulfillment work.

## Policy

A shipment in `awaiting-package` has not started seller package preparation. If Ordering records buyer cancellation while the shipment is in that state, Fulfillment cancels the shipment and prevents package, label, dispatch, delivery, return, and exception actions for it.

Once package preparation is recorded, the self-service cancellation window is closed. Later buyer cancellation requests belong to Support because the seller may have already spent labor, purchased postage, or handed the package to a carrier.

Fulfillment does not decide whether the order should be cancelled and does not issue buyer refunds. It publishes shipment facts and reacts to Ordering cancellation facts within its own shipment lifecycle.
