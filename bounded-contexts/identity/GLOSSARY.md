# Identity Domain Glossary

This glossary defines the canonical terminology for the Identity domain.  
These terms must be used consistently across:

- Database schema
- APIs
- Events
- Backend services
- Frontend/UI
- Documentation

Avoid introducing synonyms. Each concept has exactly one canonical term.

---

# Core Concepts

## Account

An **Account** represents a person or system that can perform actions in the marketplace.

This includes:

- Registered buyers and sellers
- Sellers
- Staff
- Administrators
- Automation accounts
- Guest checkout buyers

Notes:

- Guest checkout creates a minimal account record.
- Accounts may belong to one or more organizations.
- Accounts may have multiple credentials and authentication methods.
- Accounts are assigned roles through memberships; not permissions directly.

Examples of usage:

- accounts table
- AccountCreated event
- Account Settings (UI)

---

## Organization

An **Organization** is the root entity that owns commercial activity within the marketplace.

Organizations:

- Own orders
- Own listings
- Own offers
- Own inventory
- Own wallets and balances
- Own tax settings and tax identity
- Receive payouts
- Manage staff through memberships
- Own locations (addresses) and fulfillment settings

Examples:

- A card shop
- A distributor
- A business seller
- An individual buyer or seller

Notes:

- Organizations do not sign in; accounts sign in.
- All commerce activity is attributed to an organization.
- Even guest buyers have an associated organization for their orders and payments (even if it's not visible to them).

---

## Membership

A **Membership** links an Account to an Organization and defines what the account can do on behalf of that organization.

A membership records:

- Role
- Status
- Join date
- Audit history

Notes:

- An account may have multiple memberships.
- A membership belongs to exactly one organization.

Examples:

- memberships table
- MembershipCreated event

---

# Authorization

## Role

A **Role** defines a set of permissions assigned to a membership.

Examples:

- Owner
- Manager
- Fulfillment
- Viewer

Notes:

- Roles are scoped to an organization.
- Roles should be human-readable and stable.

---

## Permission

A **Permission** is an authorization to perform a specific action.

Examples:

- listings.create
- offers.accept
- orders.refund
- payouts.view

Notes:

- Permissions are assigned to roles.
- Permissions should be stable identifiers.

---

# Authentication

## Credential

A **Credential** is a secret or authentication factor used to verify an account.

Examples:

- Password hash
- Passkey
- OAuth token reference
- API key secret

Notes:

- Credentials must never be exposed in logs or events.

---

## Authentication Method

An **Authentication Method** is a configured way an account can sign in.

Examples:

- Password
- Passkey
- Google login
- Magic link
- SMS code

Notes:

- An account may have multiple authentication methods.

---

## Session

A **Session** is a time-bounded authenticated interaction between an account and the system.

Examples:

- Web session
- Mobile session

Notes:

- Sessions may expire or be revoked.

---

## API Key

An **API Key** is a credential used by software or integrations to access the system without interactive login.

Notes:

- API keys belong to accounts.
- API keys should support rotation and revocation.

---

# Representation and Communication

## Profile

A **Profile** is the collection of display and contact information associated with an account or organization.

Examples:

- Display name
- Avatar
- Store name
- Public bio

Notes:

- Profiles are representational only.
- Profiles must not contain permissions or credentials.

---

## Contact Method

A **Contact Method** is a way to reach or verify an account.

Examples:

- Email address
- Phone number

Notes:

- An account may have multiple contact methods.
- Contact methods may require verification.

---

## Verification

A **Verification** records whether a contact method or identity attribute has been confirmed.

Examples:

- Email verified
- Phone verified
- Identity verification completed

Notes:

- Verification records should include timestamp and method.

---

# Organization Lifecycle

## Invitation

An **Invitation** is a request for an account or email address to join an organization with a specific role.

Examples:

- Inviting a staff member
- Inviting a fulfillment worker

Notes:

- Invitations may expire.
- Invitations may be accepted or declined.

---

## Consent

A **Consent** records that an account or organization agreed to a policy, contract, or terms.

Examples:

- Terms of Service acceptance
- Seller agreement acceptance
- Privacy policy acknowledgment

Notes:

- Consents should be versioned.
- Consents must be auditable.

---

# Auditing and Events

All stored/transmitted events (not domain) and audit records must include:

- performedByAccountId
- forOrganizationId

These fields identify:

- The account that performed the action
- The organization the action was performed for

Notes:

- These are audit fields, not domain entities.
- Automation and system processes use automation accounts.

---

# Domain Invariants

The following rules must always hold:

1. All actions are performed by an Account for an Organization.
2. Organizations are the root of all commerce activity.
3. Accounts never directly own listings, offers, wallets, or orders.

---

# Language Rules

To maintain consistency:

1. Use **Account**, not User or Identity.
2. Use **Membership**, not Member or Organization Member.
3. Use **Organization** as the commercial owner of listings, offers, wallets, and orders.
4. Use glossary terms consistently in:
   - Table names
   - Event names
   - API routes
   - UI labels
   - Documentation

---
