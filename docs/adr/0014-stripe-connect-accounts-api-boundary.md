# ADR 0014: Stripe Connect Accounts API Boundary

## Status

Accepted and implemented for launch compatibility

## Context

Chase Sets needs a launch-compatible Stripe Connect account path while Stripe Accounts v2 approval is pending. The existing money movement contract is already provider-neutral: Settlement asks for payout account readiness, embedded setup sessions, transfers, payouts, and webhook events through `MoneyMovementGateway`. The Stripe infrastructure adapter is the only layer that needs to know whether connected payout accounts are managed through Accounts v1 or Accounts v2.

Buyer checkout remains platform-held. This decision does not introduce direct charges, destination charges, or changes to the Settlement ledger.

## Decision

Keep one public Stripe money-movement factory, `createStripeConnectMoneyMovementGateway`, and put Accounts API differences behind an internal strategy selected by `STRIPE_CONNECT_ACCOUNTS_API=v1|v2`.

The selected strategy owns connected-account provisioning, account retrieval, contact update, readiness mapping, and account-readiness webhook event names. Shared Stripe behavior stays outside the strategy: webhook signature verification, `payout.paid`, `payout.failed`, platform balance reads, platform-to-connected transfers, connected-account payouts, payout retrieval, provider errors, idempotency, and HTTP plumbing.

`contracts/money-movement` and Settlement remain unchanged. They must not receive Stripe Accounts v1 or v2 response shapes.

## Alternatives Considered

- Separate public factories for v1 and v2. Rejected because platform composition would need to know more about Stripe account internals and future changes would branch deployable code instead of infrastructure code.
- Replace v2 with v1 permanently. Rejected because v2 remains the clearer long-term API once provider approval and migration readiness are available; v1 is the launch-compatible posture while that approval is pending.
- Keep the implicit v2-only adapter. Rejected because it keeps launch posture hidden and makes v1 compatibility risky to add later.

## Consequences

The current implementation accepts `v1` and `v2` through runtime config. Accounts v1 is launch-compatible only when proof shows dashboard-none controller posture, application-owned losses, application-paid fees, application-owned requirement collection, embedded Account Sessions, platform-held transfers, connected-account payouts, and Connect webhook readiness handling. Accounts v2 remains the preferred migration target because it represents the same responsibilities through first-class recipient configuration.

Go-live webhook requirements follow the selected Accounts API: v2 requires `v2.core.account[requirements].updated` and `v2.core.account.updated`; v1 requires `account.updated`.
