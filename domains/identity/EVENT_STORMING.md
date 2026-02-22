# Identity Event Storming Contracts

This document captures the implemented identity event model and points to the source-of-truth TypeScript contracts.

## Source Files

- `packages/primatives/ids.ts`
- `packages/events/domainEvent.ts`
- `domains/identity/events.ts`
- `domains/identity/aggregates.ts`
- `domains/identity/validation.ts`

## Event Envelope Requirements

All domain events include:

- `id`
- `type`
- `aggregate`
- `version`
- `occurredAt`
- `performedByAccountId`
- `forOrganizationId`
- `commandId?`
- `correlationId?`
- `data`

## Naming Conventions

- Event type format: `identity.<aggregate>.<action>.v1`
- Aggregate types:
  - `account`
  - `organization`
  - `membership`
  - `role`
  - `invitation`
  - `consent`
  - `contact_method`
  - `verification`
  - `credential`
  - `authentication_method`
  - `session`
  - `api_key`

## Aggregate Event Streams

Implemented event catalogs and payload contracts are defined in `domains/identity/events.ts` for:

- Account
- Organization
- Membership
- Role
- Invitation
- Consent
- Contact Method
- Verification
- Credential
- Authentication Method
- Session
- API Key

## Rehydration and Transition Enforcement

`domains/identity/aggregates.ts` provides:

- Per-aggregate `apply<Event>` reducers
- Per-aggregate `rehydrate<Aggregate>` functions
- Generic `rehydrateIdentityAggregate` dispatch
- Transition protection for:
  - invitation terminal-state constraints
  - membership role change when removed
  - session refresh after revoked/expired

## Validation

`domains/identity/validation.ts` provides:

- Event envelope validation
- Aggregate/event type compatibility checks
- Stream version monotonicity checks
- Duplicate `commandId` checks
- Sensitive-field-name guards for credential/api key payloads
