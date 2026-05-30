# Support Operations Readiness

Support must be operational before public marketplace transactions open.

## Account Surface

The marketplace account support route lets an authenticated account open a structured support request from an order id, role, and configured issue flow. Buyer and seller request lists show status, priority, next deadline, and required checklist progress so accounts can see whether the issue is waiting on a party or support.

## Operations Gate

Before `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true`, support operations must verify:

- buyer and seller issue opening works against staging order sources;
- urgent and overdue requests appear in the operations queue;
- `/operations/support-requests` in admin-web loads the Support-owned operations queue for an actor with `support.manage`;
- evidence, response, escalation, resolution, close, and cancel endpoints are rehearsed;
- refund-producing resolutions are visible to Payments;
- open support requests hold seller proceeds in Settlement;
- transactional email notices are enabled for support-relevant account events.

Approval is carried by `PRODUCTION_SUPPORT_OPERATIONS_APPROVED=true` and a non-empty `PRODUCTION_SUPPORT_OPERATIONS_REFERENCE` in the production GitHub Environment. The reference must point to the Support-owned rehearsal record covering the queue review, overdue escalation, lifecycle endpoints, refund-producing resolution, settlement hold, and notification checks. Keep approval unset while production remains landing/admin-support only or while support operations has not completed the staging rehearsal.
The redacted [Marketplace Launch Evidence](../../../docs/runbooks/marketplace-launch-evidence.md) packet must carry the same approval and reference before operators set the production GitHub Environment values.

## Operator Surface

The admin Support operations route is contributed by the Support bounded context, not by the admin deployable. It lists urgent, overdue, and ready-for-support requests from the Support operations queue and can run the overdue escalation command. While production is still landing/admin-support and the Support API is not deployed there, the route reports the unavailable API instead of opening live support operations.

## Ownership

Support owns the structured request lifecycle, flow catalog, deadlines, and support operations queue. Payments owns refund effects from support resolutions. Settlement owns payout holds and release decisions that depend on open support state.
