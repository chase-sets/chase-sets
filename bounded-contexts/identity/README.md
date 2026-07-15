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
- Shipping Address
- User Preferences
- Verification
- Invitation
- Founders Cohort
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
- Inventory storage locations and Fulfillment ship-from locations
- Notification delivery settings and channel policy
- Device-local anonymous visitor presentation fallbacks

## Ubiquitous Language

Identity terminology is defined in [GLOSSARY.md](./GLOSSARY.md). Use that glossary as the canonical style guide for new context glossaries.

User preference ownership is governed by [Settings Ownership](../../docs/architecture/settings-ownership.md). The completed milestone #55 proof is retained in [issue #2704](https://github.com/chase-sets/chase-sets/issues/2704).

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
- `AccountBadgeAssigned`
- `AccountBadgeRemoved`
- `FoundersWindowOpened`
- `FounderNumberClaimed`
- `MembershipGranted`
- `MembershipRevoked`
- `ContactMethodVerified`
- `ConsentRecorded`
- `ConsentWithdrawn`

## Invariants

1. All actions are performed by a User for an Account.
2. Accounts are the root of all commerce activity.
3. Users never directly own listings, offers, wallets, or orders.
4. Buying and selling are available to active accounts by default.
5. Buyer and Seller remain contextual transaction roles, not account capability classes.

## Tests

Run `pnpm --filter @chase-sets/identity run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/identity run test` before opening a PR.

## Boundary Notes

- Identity owns identity-management behavior and admin surfaces.
- Identity owns viewer presentation preferences that belong to a signed-in User across accounts and devices.
- Auth owns interactive authentication journeys and the `/api/auth` surface.
- Notifications owns behavior-coupled notification settings; Identity does not own delivery policy.
- Identity must not re-expose browser auth pages or auth-specific clients as part of its public web surface.

## Feature vs Composition

- **Feature code stays in slices.** Domain behavior, queries, and projections belong in Identity-owned feature slices under `bounded-contexts/identity/features/`, not in composition folders.
- **`routes/` is adapter-only.** Files under `bounded-contexts/identity/routes/` should stay thin route adapters that wire deployable contracts to slice-owned feature modules.
- **`support/` is composition-only.** Keep shell layout, request helpers, and host-facing composition modules in `bounded-contexts/identity/support/*-support/`; do not place feature domain/query/projection logic there.
- **Deployables remain thin roots.** Deployables should resolve Identity route and shell contributions through `@chase-sets/platform-runtime`, which then mounts Identity-owned route modules.

## Open Extraction Candidates

- Compliance can be extracted later if consent, policy versioning, and identity verification become materially more complex.
