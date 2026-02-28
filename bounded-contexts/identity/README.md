# Identity Bounded Context

## Purpose

Identity owns who can act in Chase Sets and which organization they act for.

## Owns

- Account
- Organization
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

- Organization
- Account
- Membership
- Invitation
- Session

## Incoming Dependencies

- None. Identity is an upstream context.

## Outgoing Integration Events

- `OrganizationCreated`
- `OrganizationProfileUpdated`
- `MembershipGranted`
- `MembershipRevoked`
- `ContactMethodVerified`
- `ConsentRecorded`

## Invariants

1. All actions are performed by an Account for an Organization.
2. Organizations are the root of all commerce activity.
3. Accounts never directly own listings, offers, wallets, or orders.
4. Buyer and Seller remain roles an Organization plays in downstream contexts.

## Open Extraction Candidates

- Compliance can be extracted later if consent, policy versioning, and identity verification become materially more complex.
