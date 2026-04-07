# Identity Bounded Context

## Purpose

Identity owns users and the accounts they act for in Chase Sets.

## Owns

- User
- Account
- Membership
- Role
- Permission
- API Key
- Profile
- Contact Method
- Verification
- Invitation
- Consent

## Does Not Own

- Sign-in
- Registration
- Sign-out
- Account selection during authentication
- Browser session-token persistence
- Session aggregates and session revocation
- Authentication challenges and credential verification flows
- Listings
- Inventory
- Orders
- Payments
- Shipments

## Ubiquitous Language

Identity terminology is defined in [GLOSSARY.md](./GLOSSARY.md). Use that glossary as the canonical style guide for new context glossaries.

## Core Aggregates and Process Managers

- Account
- User
- Membership
- Invitation
- API Key

## Incoming Dependencies

- Auth projects Identity-published user, membership, and invitation facts into auth-owned tables for local reads.
- Auth uses `@chase-sets/identity/server` for the narrow synchronous identity mutations that still belong to Identity.

## Outgoing Integration Events

- `UserCreated`
- `AccountCreated`
- `AccountProfileUpdated`
- `MembershipGranted`
- `MembershipRevoked`
- `ContactMethodVerified`
- `ConsentRecorded`

## Invariants

1. All actions are performed by a User for an Account.
2. Accounts are the root of all commerce activity.
3. Users never directly own listings, offers, wallets, or orders.
4. Buyer and Seller remain roles an Account plays in downstream contexts.

## Boundary Notes

- Identity owns identity-management behavior and admin surfaces.
- Auth owns interactive authentication journeys and the `/api/auth` surface.
- Identity must not re-expose browser auth pages or auth-specific clients as part of its public web surface.

## Feature vs Composition

- **Feature code stays in slices.** Domain behavior, queries, and projections belong in Identity-owned slices (for example `admin/` and `account/` modules), not in composition folders.
- **`routes/` is adapter-only.** Files under `bounded-contexts/identity/routes/` should stay thin route adapters that wire deployable contracts to slice-owned feature modules.
- **`shell-support/` is composition-only.** Keep shell layout, shell navigation, and host-facing shell helpers in `bounded-contexts/identity/shell-support/`; do not place feature domain/query/projection logic there.
- **Deployables remain thin roots.** Deployables should consume generated inventories such as `deployables/*/app/context-routes.generated.ts` and `deployables/*/app/context-shell.generated.ts`, which in turn mount Identity-owned route modules.

## Open Extraction Candidates

- Compliance can be extracted later if consent, policy versioning, and identity verification become materially more complex.
