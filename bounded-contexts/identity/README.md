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
- Account-scoped session records used for audit and account switching

## Does Not Own

- Sign-in
- Registration
- Sign-out
- Account selection during authentication
- Browser session-token persistence
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
- Account Session Record

## Incoming Dependencies

- Auth depends on Identity through `@chase-sets/identity/integration` for user, account, membership, and invitation facts.

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

## Open Extraction Candidates

- Compliance can be extracted later if consent, policy versioning, and identity verification become materially more complex.
