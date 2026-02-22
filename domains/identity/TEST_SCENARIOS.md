# Identity Event Test Scenarios

These scenarios map to the implemented contracts in:

- `domains/identity/events.ts`
- `domains/identity/aggregates.ts`
- `domains/identity/validation.ts`

## Rebuild Per Aggregate

For each aggregate stream, replay events with its `rehydrate*` function and assert final state equals command-model expectation.

## Transition Validity

- Reject `identity.invitation.accepted.v1` after `identity.invitation.expired.v1`.
- Reject `identity.membership.role_changed.v1` when membership status is `removed`.
- Reject `identity.session.refreshed.v1` after `identity.session.revoked.v1` or `identity.session.expired.v1`.

## Envelope Invariants

- Every event must include valid `performedByAccountId` and `forOrganizationId`.
- Every event type must match `identity.<aggregate>.<action>.v1`.
- `aggregate.type` must match allowed identity aggregate set.

## Security Invariants

- Credential and API key payloads must not include sensitive key names.
- Secrets must be represented by references only (for example `credentialId`), never raw values.

## Concurrency and Idempotency

- Stream versions must be contiguous and increasing by 1.
- Duplicate `commandId` values in a single stream are rejected.

## Cross-Aggregate Workflow Checks

- Account onboarding flow:
  - `identity.account.created.v1`
  - `identity.organization.created.v1` (`isPersonal=true`)
  - `identity.membership.created.v1` (owner role path)
  - `identity.consent.recorded.v1`

- Staff invitation flow:
  - created -> accepted -> membership created
  - created -> declined
  - created -> revoked
  - created -> expired

- Contact verification flow:
  - contact method added -> verification requested -> verification completed -> contact method verified

## Backward Compatibility

- Existing `.v1` handlers should tolerate additive fields.
- Unknown optional metadata should not break replay.
