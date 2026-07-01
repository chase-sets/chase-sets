# ADR 0014: Stripe Connect Accounts API Boundary

## Status

Accepted

## Context

Chase Sets needs a launch-compatible Stripe Connect account path while Stripe Accounts v2 approval is pending. The existing money movement contract is already provider-neutral: Settlement asks for payout account readiness, embedded setup sessions, transfers, payouts, and webhook events through `MoneyMovementGateway`. The Stripe infrastructure adapter is the only layer that needs to know whether connected payout accounts are managed through Accounts v1 or Accounts v2.

Buyer checkout remains platform-held. This decision does not introduce direct charges, destination charges, or changes to the Settlement ledger.

## Decision

Keep one public Stripe money-movement factory, `createStripeConnectMoneyMovementGateway`, and put Accounts API differences behind an internal strategy selected by `STRIPE_CONNECT_ACCOUNTS_API=v1|v2`.

The selected strategy owns connected-account provisioning, account retrieval, contact update, readiness mapping, and account-readiness webhook event names. Shared Stripe behavior stays outside the strategy: webhook signature verification, `payout.paid`, `payout.failed`, platform balance reads, platform-to-connected transfers, connected-account payouts, payout retrieval, provider errors, idempotency, and HTTP plumbing.

`contracts/money-movement` and Settlement remain unchanged. They must not receive Stripe Accounts v1 or v2 response shapes.

## Alternatives Considered

- Separate public factories for v1 and v2. Rejected because platform composition would need to know more about Stripe account internals and future changes would branch deployable code instead of infrastructure code.
- Replace v2 with v1 immediately. Rejected for this boundary change because the v1 provisioning/readiness strategy still needs focused implementation and proof in the follow-up issues.
- Keep the implicit v2-only adapter. Rejected because it keeps launch posture hidden and makes v1 compatibility risky to add later.

## Consequences

The current implementation keeps `v2` as the default until the Accounts v1 strategy is implemented. Selecting `v1` is accepted by runtime config but the Stripe adapter fails closed with a configuration error for account operations until the v1 child issues land.

Go-live webhook requirements follow the selected Accounts API: v2 requires `v2.core.account[requirements].updated` and `v2.core.account.updated`; v1 requires `account.updated`.
