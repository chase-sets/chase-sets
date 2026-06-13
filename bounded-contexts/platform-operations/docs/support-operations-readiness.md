# Support Operations Readiness

Support must be operational before public marketplace transactions open.

## Account Surface

The marketplace account support route lets an authenticated account open a structured support request from an order id, role, and configured issue flow. Buyer and seller request lists show status, priority, next deadline, and required checklist progress so accounts can see whether the issue is waiting on a party or support.

## Operations Gate

Before `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true`, support operations must verify:

- buyer and seller issue opening works against staging order sources;
- urgent and overdue requests appear in the operations queue;
- `/support/requests` in admin-web loads the Support-owned operations queue for an actor with `support.manage`;
- evidence, response, escalation, resolution, close, and cancel endpoints are rehearsed;
- refund-producing resolutions are visible to Payments;
- open support requests hold seller proceeds in Settlement;
- transactional email notices are enabled for support-relevant account events.

Approval is carried by `PRODUCTION_SUPPORT_OPERATIONS_APPROVED=true` and a non-empty `PRODUCTION_SUPPORT_OPERATIONS_REFERENCE` in the production GitHub Environment. The reference points to the Support-owned readiness record or launch review ticket covering the checks above, with Payments and Settlement links when refund-producing resolutions or seller-proceeds holds are part of the proof. Keep approval unset while production remains landing/admin-support only, while the Support API or admin route is not available for the launch posture, or while any required support workflow fails.

Checkout-specific support triage lives in the [Checkout Support Operations](../../../docs/runbooks/checkout-support-operations.md) runbook. It maps stuck checkout, payment dispute, missing or failed downstream handoff, and refund request launch scenarios to the support flow catalog without creating fake order support requests for pre-confirmation checkout recovery.

## Operator Surface

The admin Support operations route is contributed by the Support bounded context, not by the admin deployable. It lists urgent, overdue, and ready-for-support requests from the Support operations queue and can run the overdue escalation command. While production is still landing/admin-support and the Support API is not deployed there, the route reports the unavailable API instead of opening live support operations.

## Ownership

Support owns the structured request lifecycle, flow catalog, deadlines, and support operations queue. Payments owns refund effects from support resolutions. Settlement owns payout holds and release decisions that depend on open support state.
