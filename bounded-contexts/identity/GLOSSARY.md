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

## User

A **User** represents a person or system that can perform actions in the marketplace.

This includes:

- Registered account users
- Staff
- Administrators
- Automation users
- Guest checkout users

Notes:

- Guest checkout creates a minimal user record plus a corresponding account item.
- Users may belong to one or more accounts.
- Users may have multiple credentials and authentication methods.
- Users are assigned roles through memberships; not permissions directly.

Examples of usage:

- users table
- UserCreated event
- User Settings (UI)

---

## Account

An **Account** is the root entity that owns commercial activity within the marketplace.

Accounts:

- Own orders
- Own listings
- Own offers
- Own inventory
- Own wallets and balances
- Own tax settings and tax identity
- Receive payouts
- Manage users and automation through memberships
- Own locations (addresses) and fulfillment settings

Examples:

- A card shop
- A distributor
- A business trading account
- An individual trading account

Notes:

- Accounts do not sign in; users sign in.
- All commerce activity is attributed to an account.
- Even guest checkout users have an associated account for their orders and payments (even if it's not visible to them).
- Buying and selling are not account capability classes; accounts may play buyer or seller roles only inside transaction-specific contexts.

---

## Membership

A **Membership** links a User to an Account and defines what the user can do on behalf of that account.

A membership records:

- Role
- Status
- Join date
- Audit history

Notes:

- A user may have multiple memberships.
- An account may have multiple memberships.
- A membership belongs to exactly one account.

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

- Roles are scoped to an account.
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

A **Credential** is a secret or authentication factor used to verify a user.

Examples:

- Password hash
- Passkey
- OAuth token reference
- API key secret

Notes:

- Credentials must never be exposed in logs or events.
- Interactive credential verification and challenge handling are owned by Auth.
- Identity keeps only the user-level references needed for account and membership management.

---

## Authentication Method

An **Authentication Method** is a configured way a user can sign in.

Examples:

- Password
- Passkey
- Google login
- Magic link
- SMS code

Notes:

- A user may have multiple authentication methods.
- Auth owns the sign-in and registration journey that uses these methods.

---

## API Key

An **API Key** is a credential used by software or integrations to access the system without interactive login.

Notes:

- API keys belong to users.
- API keys should support rotation and revocation.

---

# Representation and Communication

## Profile

A **Profile** is the collection of display and contact information associated with a user or account.

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

A **Contact Method** is a way to reach or verify a user.

Examples:

- Email address
- Phone number

Notes:

- A user may have multiple contact methods.
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

# Account Lifecycle

## Invitation

An **Invitation** is a request for a user or email address to join an account with a specific role.

Examples:

- Inviting a staff member
- Inviting a fulfillment worker

Notes:

- Invitations may expire.
- Invitations may be accepted or declined.

---

## Consent

A **Consent** records that a user or account agreed to a policy, contract, or terms.

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

- performedByUserId
- forAccountId

These fields identify:

- The user that performed the action
- The account the action was performed for

Notes:

- These are audit fields, not domain entities.
- Automation and system processes use automation users.

---

# Domain Invariants

The following rules must always hold:

1. All actions are performed by a User for an Account.
2. Accounts are the root of all commerce activity.
3. Users never directly own listings, offers, wallets, or orders.

---

# Language Rules

To maintain consistency:

1. Use **User** for the acting identity, not Account or Identity.
2. Use **Membership**, not Member or Account Member.
3. Use **Account** as the commercial owner of listings, offers, wallets, and orders.
4. Use glossary terms consistently in:
   - Table names
   - Event names
   - API routes
   - UI labels
   - Documentation

---
