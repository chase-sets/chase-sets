# Support Operations Readiness

Support must be operational before public marketplace transactions open.

## Account Surface

The marketplace account support route lets an authenticated account open a structured support request from an order id, role, and configured issue flow. Buyer and seller request lists show status, priority, next deadline, and required checklist progress so accounts can see whether the issue is waiting on a party or support.

## Operations Gate

Before `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true`, support operations must verify:

- buyer and seller issue opening works against staging order sources;
- urgent and overdue requests appear in the operations queue;
- evidence, response, escalation, resolution, close, and cancel endpoints are rehearsed;
- refund-producing resolutions are visible to Payments;
- open support requests hold seller proceeds in Settlement;
- transactional email notices are enabled for support-relevant account events.

## Ownership

Support owns the structured request lifecycle, flow catalog, deadlines, and support operations queue. Payments owns refund effects from support resolutions. Settlement owns payout holds and release decisions that depend on open support state.

