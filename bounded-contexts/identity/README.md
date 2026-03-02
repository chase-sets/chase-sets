# Identity Bounded Context

## Purpose

Identity owns users and the accounts they act for in Chase Sets.

## Owns

- User
- Account
- Membership
- Role
- Permission
- Credential
- Authentication Method
- Session
- API Key
- Profile
- Contact Method
- Verification
- Invitation
- Consent

## Does Not Own

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
- Session

## Incoming Dependencies

- None. Identity is an upstream context.

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

## Open Extraction Candidates

- Compliance can be extracted later if consent, policy versioning, and identity verification become materially more complex.
