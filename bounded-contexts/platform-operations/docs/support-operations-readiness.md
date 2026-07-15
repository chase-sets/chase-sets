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

Approval is carried by `PRODUCTION_SUPPORT_OPERATIONS_APPROVED=true` and a non-empty `PRODUCTION_SUPPORT_OPERATIONS_REFERENCE` in the production GitHub Environment. The reference points to the Support-owned readiness record or launch review ticket covering the checks above, with Payments and Settlement links when refund-producing resolutions or seller-proceeds holds are part of the proof. Keep approval unset while production remains landing-profile only, while the Support API or admin route is not available for the launch posture, or while any required support workflow fails.

Checkout-specific support triage lives in the [Checkout Support Operations](../../../docs/runbooks/checkout-support-operations.md) runbook. It maps stuck checkout, payment dispute, missing or failed downstream handoff, and refund request launch scenarios to the support flow catalog without creating fake order support requests for pre-confirmation checkout recovery.

## Operator Surface

The admin Support operations route is contributed by the Support bounded context, not by the admin deployable. It lists urgent, overdue, and ready-for-support requests from the Support operations queue and can run the overdue escalation command. While production is still landing-profile only and the Support API is not deployed there, the route reports the unavailable API instead of opening live support operations.

## Platform-Funded Remedy Runbook

Only operators holding the purpose-specific `support.remedies.*` capabilities may use this workflow. `support.manage` alone is insufficient. Before requesting a reservation, compare the case evidence, enter the buyer remedy, seller/platform allocation, return directive, and refund trigger independently, then review the server-produced exposure preview. The preview is advisory; the server re-evaluates the active policy when the proposal and each approval are submitted.

Use these recovery paths:

- **Approval** — confirm the reservation is `reserved`, the amounts and four decision dimensions still match the case decision, and the policy version is expected. Complete every displayed approval. When dual control is required, the proposer cannot approve and each approver must be distinct; an elevated approval is mandatory when displayed.
- **Reservation rejection** — do not authorize or recreate the reservation. Record a correction or escalation using `coverage-rejected`, include the machine reason and evidence reference, and route the reserve-capacity question to Settlement.
- **Reservation timeout or expiry** — do not approve after the stamped expiry. Request correction with `reservation-expired`; Settlement owns release/expiry of the old reservation, and a new proposal is allowed only after the correction is adjudicated.
- **Lost return or carrier exception** — keep the case open. Use the `carrier-exception` correction path with tracking and evidence. A non-financial effect may be waived only with `support.remedies.waive`; coverage, refund, and reconciliation facts can never be waived.
- **Refund provider failure** — use **Retry same intent** only for `failed-retryable`. The retry event repeats the existing correlated remedy/effect intent and idempotency key lineage; never create a second remedy, reservation, or refund. Escalate `refund-failure` when the failure is terminal.
- **Stuck reconciliation** — never mark the financial effect complete manually. Request correction with `reconciliation-stuck` and route it to Settlement. The support case remains closure-blocked until Settlement publishes the matching reconciliation fact.
- **Escalation** — use the displayed correction action for policy exceptions, rejected/expired reservations, carrier failures, refund failures, or stuck reconciliation. Preserve the reason code, free-text rationale, evidence references, policy version, correlation id, actor, permission, and timestamp in the case audit trail.

Human proposal, approval, retry, waiver, release, and correction entries show an account actor and permission. Reservation and owning-context facts show `System/service`; never represent a service reaction as a human decision. Closure is allowed only when the lifecycle reports completion and the exact blocking-effects list is empty.

## Ownership

Support owns the structured request lifecycle, flow catalog, platform-remedy policy, approvals, recovery intents, deadlines, and support operations queue. Payments owns refund execution. Settlement owns protection-coverage reservations, payout holds, liability allocation, reserve consumption, and financial reconciliation.
