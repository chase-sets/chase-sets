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

## Identity Concepts

### User

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

### Account

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
- Own recipient shipping addresses used for checkout reuse

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
- Seller operational locations remain separate: Inventory owns storage locations for account-held stock, and Fulfillment owns ship-from locations and shipment execution.

### Account Badge

An **Account Badge** is an Identity-owned trust or participation marker assigned to an Account and displayed beside account identity surfaces.

Notes:

- Account Badges belong to Accounts, not Users, Memberships, Buyer roles, or Seller roles.
- Account Badges must be assigned through Identity-owned account behavior so replay preserves the same visible account markers.
- A **Founding Account Badge** is a permanent, numbered Account Badge claimed by an admitted Account's first Qualifying Act, while one of the 500 Founder Numbers remains.
- A **Trusted Seller Account Badge** marks an Account that operations has approved for standard high-dollar listing and payout-release policies.
- A **Manual Payout Review Account Badge** marks an Account whose payout release requires enhanced review because Stripe, support, fulfillment, or operations found seller-risk signals.

### Founders Cohort

The **Founders Cohort** is the capped set of admitted Accounts that can claim one of 500 Founder Numbers in activation order.

Notes:

- Admission opens the Account's Founders Window but does not consume a Founder Number.
- A single event stream serializes Founder Number claims and enforces the cap.

### Founder Number

A **Founder Number** is the permanent activation-order number, from 1 through 500, claimed once per admitted Account by its first Qualifying Act.

### Founders Window

A **Founders Window** is the 60-day period beginning when an Account receives beta access. Every Listing created during that half-open interval locks the Account's 0% Marketplace Sales Fee through the existing listing fee-lock mechanism.

Notes:

- The Founders Window is anchored to beta access, not badge claim.
- The window includes its start and excludes the instant exactly 60 days later.
- Identity owns admission and the window timestamps; Commercial Terms implements the window as an account-specific Commercial Agreement.

### Qualifying Act

A **Qualifying Act** is an admitted Account's creation of a Listing or submission of an Offer.

Notes:

- Only the Account that makes the Offer qualifies; an Account receiving an Offer does not.
- Purchases, invitations, registration, and passive receipt of an Offer are not Qualifying Acts.

### Membership

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

### User Preferences

**User Preferences** are durable User-owned presentation choices that should follow a signed-in user across accounts and devices.

Examples:

- color mode
- density
- reduced motion
- locale
- time zone

Notes:

- User Preferences belong to the User, not an Account.
- Viewer presentation preferences live in Identity because they describe the signed-in user's cross-device presentation choices.
- Behavior-coupled settings stay with the context that owns the behavior, such as Notifications-owned delivery settings.
- Device ephemera and anonymous visitor fallbacks stay client-local and are not Identity facts.

## Permission Model

### Role

A **Role** defines a set of permissions assigned to a membership.

Examples:

- Owner
- Manager
- Fulfillment
- Viewer

Notes:

- Roles are scoped to an account.
- Roles should be human-readable and stable.

### Permission

A **Permission** is an authorization to perform a specific action.

Examples:

- listings.create
- offers.accept
- orders.refund
- payouts.view

Notes:

- Permissions are assigned to roles.
- Permissions should be stable identifiers.

## Credential Model

### Credential

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

### Authentication Method

An **Authentication Method** is a configured way a user can sign in.

Examples:

- Password
- Passkey
- Google login
- Magic link
- SMS code (`sms-code`)

Notes:

- A user may have multiple authentication methods.
- Auth owns the sign-in and registration journey that uses these methods.
- Identity owns the durable fact that the method is enabled for a User.

### Social Login Link

A **Social Login Link** records that one external provider identity can authenticate one User.

Examples:

- A Google subject linked to a User
- A Facebook subject linked to a User

Notes:

- Identity owns the durable link fact because it belongs to the User's authentication methods.
- Auth owns the provider redirect, callback verification, and session journey.
- A provider identity must not be linked to more than one User.
- Provider tokens and raw profile payloads are not Identity facts.

### API Key

An **API Key** is a credential used by software or integrations to access the system without interactive login.

Notes:

- API keys belong to users.
- API keys should support rotation and revocation.

## Representation and Communication

### Profile

A **Profile** is the collection of display and contact information associated with a user or account.

Examples:

- Display name
- Avatar
- Store name
- Public bio

Notes:

- Profiles are representational only.
- Profiles must not contain permissions or credentials.

### Contact Method

A **Contact Method** is a way to reach or verify a user.

Examples:

- Email address
- Phone number

Notes:

- A user may have multiple contact methods.
- Contact methods may require verification.
- Email addresses and phone numbers used for sign-in are normalized before lookup.

### Verification

A **Verification** records whether a contact method or identity attribute has been confirmed.

Examples:

- Email verified
- Phone verified
- Identity verification completed

Notes:

- Verification records should include timestamp and method.

## Account Lifecycle

### Invitation

An **Invitation** is a request for a user or email address to join an account with a specific role.

Examples:

- Inviting a staff member
- Inviting a fulfillment worker

Notes:

- Invitations may expire.
- Invitations may be accepted or declined.

### Consent

A **Consent** records that a user or account agreed to a policy, contract, or terms.

Examples:

- Terms of Service acceptance
- Seller agreement acceptance
- Privacy policy acknowledgment

Notes:

- Consents should be versioned.
- Consents must be auditable.
- A recorded Consent can be withdrawn. Withdrawal ends the current agreement without deleting its audit history; later agreement creates a new Consent record.

### Consent Recording Authorization

A **Consent Recording Authorization** is the trusted, explicit admission value that binds a Consent recording or withdrawal to the authoritative request identity.

Notes:

- The authorization is never derived from the Consent command.
- The authorized-actor form is derived from the request audit User and Account.
- Self-registration can authorize only the User and Account identifiers minted by that registration while running as the Identity bootstrap principal.
- Provisioning can authorize only its explicitly selected User and Account while running as the Identity bootstrap principal.
- Shared guest-checkout and Identity bootstrap principals are never Consent subjects.

### Consent Activation Authority

A **Consent Activation Authority** is the single event-sourced answer to "is this consent-capable policy key activated, at which version, and what token guards that answer". There is exactly one per policy key, and its identity is derived from the policy key alone — so it exists, and can be guarded against, before the key has ever been activated.

Identity owns the Consent facts and the meaning of agreement; the shared platform-policy machinery (`infrastructure/platform-policy`) owns the authority mechanism, the same way it owns [[Policy Document]] storage and revision mechanics for the contexts that adopt it.

Notes:

- **Consent-capable is not activated.** Registering a policy key declares that it *may* carry Consents. Only an explicit activation activates it, and registration never implies one.
- **Never-activated and inactive are different states.** A key that was activated and later deactivated is inactive; only a never-activated key can be first-activated. Deactivation does not return a key to never-activated.
- **Activation is aggregate state, never presence.** An active policy document, a projection row, or a stream row for the key is not an activation. A document is the policy *value*; the authority is the *activation*.
- Activation state, the active version, and the guard token are always read together from the authority's own event stream. A cached policy value must never be paired with a separately read authority revision.
- The authority is the identity Consent recording needs. [[Consent Bundle]] composes several authorities for one surface and is the read-side consumer that exists today; the elimination sweep for consent-activation races and the write call sites that commit against a guard are owned elsewhere and do not exist yet.

### Consent Bundle

A **Consent Bundle** is the ordered set of consent policies one surface asks a subject to agree to, together with the scope the agreement is recorded against. There are exactly two: `registration`, which is user-scoped and declares Terms of Service then Privacy Policy; and `seller-onboarding`, which is account-scoped and declares Seller Agreement then Payments Terms.

A bundle has a **declared member** list and a **derived requirement** list, and they are different things. A declared member is a consent policy the surface is *allowed* to require. A derived requirement is a member bound to the exact version a [[Consent Activation Authority]] says is active right now, plus where that version is readable.

Today the Consent Bundle is a domain and read-side capability: it resolves bundles, answers per-policy and per-bundle acceptance, and backs the Terms of Service acceptance gate. Binding Consent recording and atomic registration to a resolved bundle — including the ordered requirements a [[Registration Consent Resolution]] carries — is owned by a separate slice and is not part of this capability.

Notes:

- **Declaring a member never activates it.** Adding a policy to a bundle declaration widens what that surface may require and changes nothing about what it does require.
- **Order is contract.** Declared member order is the order a subject is asked and the order a derived requirement list carries. It is not incidental iteration order.
- **A member becomes a requirement only when both owners agree.** Public Presence must have compiled the document as consent-activatable, and that policy's Consent Activation Authority must be active at the same version. Either one alone derives nothing.
- **A publication-ineligible member is not asked about.** No authority is read for it, so an inert member is distinguishable from a live one in the read trace.
- **A guard is retained for every authority actually read**, including a member observed inactive, because "inactive when read" is a fact a later append has to be able to guard against.
- **One unresolvable member makes the whole bundle unresolved.** A version that contradicts its publication, or an authority that cannot be validated, yields no requirement list at all rather than a shorter one.
- **An empty requirement set is a value, not a disabled mode.** The shipped corpus derives two empty ordered sets, and resolution still ran.
- **Bundle acceptance is subject-exact and aggregate.** It is decided for exactly one subject at exactly one scope, and satisfaction requires the current state of each required member to be recorded at the exact required version. Another user of the same account, an account-scoped fact standing in for a user-scoped one, a withdrawn or superseded record, and a legacy `terms` fact never satisfy a bundle.

### Registration Consent Resolution

A **Registration Consent Resolution** is Identity's signed answer to "what must a person agree to in
order to create an identity right now, and at exactly which versions".

It carries a bundle key, an **ordered** list of Registration Consent Requirements, the instant it was
resolved, and an HMAC signature over all of them. Identity mints it and Identity verifies it; no other
context can produce one that verifies, and requirement order is part of the signed payload, so
reordering the list is tampering rather than an equivalent encoding.

Notes:

- The resolution is the only source of the policy versions recorded as Consent when a personal
  identity is created. Never raw client input, and never a fresh resolve taken at append time.
- An empty requirement list is a value, not a disabled mode. A resolution over an empty list is still
  signed, still version-bearing, and still mandatory on every first-use path.
- A resolution has a freshness window. Past it, a genuinely minted resolution stops being submittable.

### Registration Consent Requirement

One ordered element of a Registration Consent Resolution: the policy key, the exact version resolved,
and where that version is readable.

### Registration Consent Submission

A **Registration Consent Submission** is what a caller hands to identity creation: a Registration
Consent Resolution together with whether the person affirmed it.

The affirmation is a field **of** the resolution it answers, never a sibling of one the server fetched
separately. There is deliberately no shape in which a caller supplies a bare affirmation flag and lets
the server resolve afterwards — that shape is how an affirmation ends up recorded against a version
the caller was never shown.

Notes:

- The submission is a required, non-nullable parameter of personal-identity creation. A caller that
  omits it fails the typecheck gate; a request that omits it is rejected before any aggregate write.
- An unaffirmed submission is accepted only while the resolution carries no requirements. Once the
  requirement list is non-empty, a path with no way to show someone what they are agreeing to fails
  closed rather than recording an agreement nobody made.

### Registration Operation

A **Registration Operation** is one attempt to create a personal identity for one verified contact,
identified server-side so that the attempt can be recognized again.

Identity derives it from the normalized verified contact the caller already supplies — the email when
one is present, otherwise the phone — namespaced and versioned. It is never derived from the
Registration Consent Submission: that value's signature covers only the bundle key, the requirements
and the resolution time, so two unrelated registrations minted in the same second over an empty
requirement list produce identical bytes, and an identity derived from them would fuse two different
people onto one account.

The operation is claimed exactly once, on its own command-side stream, as a participant of the same
all-or-nothing append that writes the Account, the User, the Membership and every Consent in the
ordered bundle.

Notes:

- Deriving the operation changes no caller signature. Every personal-identity path already supplies a
  verified email or phone and pre-checks that contact against a projection before registering. Email
  is the stable operation contact when both are present, so an email-only retry still converges — the
  operation is what makes that intent race-free rather than merely likely.
- The claim is command-side only and belongs to no projection group. Enrolling it would place the
  convergence anchor under a truncating reset strategy.
- A retry of the same operation converges on the claimed ids and completes whatever is missing; it
  never mints a second account and never receives a display-name conflict. A registration for a
  different contact is a different operation and remains fully independent.
- Recovery first validates the claim's exact one-event history and then rehydrates every existing
  participant. An Account, User, Membership, or Consent is complete only when its identity, claim
  linkage, metadata, and required final state agree; a contradictory participant fails closed and is
  never skipped merely because its stream exists.
- Recovery is claim-anchored. A claim-less reservation may be reclaimed only while its Account has no
  committed events. Once a claim-less Account exists, registration does not adopt it or grant another
  owner Membership.
- The Account Display Name Reservation a registration writes is bound to the operation that wrote it,
  because that row cannot join the event append. A retry of the same operation reclaims its own row;
  no other operation can.
- An operation already claimed against a different ordered consent bundle fails closed and appends
  nothing, rather than recording agreement to versions nobody in that operation affirmed.

## Account Address Book

### Shipping Address

A **Shipping Address** is an account-owned recipient destination that can be reused during checkout.

Shipping addresses:

- Belong to exactly one account
- Capture recipient name, optional company, street, city, state/region, postal code, country, and optional contact details
- May be marked as the account default shipping address
- May be selected, created, or explicitly updated from checkout before the checkout session records its immutable shipping destination snapshot

Notes:

- Shipping Address is an Identity term because it is reusable account state.
- Checkout owns the active session selection and records a snapshot of the selected destination.
- Ordering and Fulfillment consume immutable shipping destination snapshots, not live Identity address records.
- Inventory Storage Location and Fulfillment Ship-from Location are separate operational concepts and must not be collapsed into Shipping Address.

### Linked Platform Authorization

A **Linked Platform Authorization** is user/account consent that permits an external platform to act through delegated UCP scopes.

Notes:

- Linked Platform Authorizations are not API keys.
- Auth owns the interactive OAuth/account-selection journey.
- Identity owns the durable consent, platform/client reference, revocation facts, and audit trail.

## Auditing and Events

All stored/transmitted events (not domain) and audit records must include:

- performedByUserId
- forAccountId

These fields identify:

- The user that performed the action
- The account the action was performed for

Notes:

- These are audit fields, not domain entities.
- Automation and system processes use automation users.

## Domain Invariants

The following rules must always hold:

1. All actions are performed by a User for an Account.
2. Accounts are the root of all commerce activity.
3. Users never directly own listings, offers, wallets, or orders.
4. Every non-closed Account retains at least one active owner Membership.

Closing an Account preserves its Memberships for audit. Membership teardown is explicit and is permitted only after the
Account is closed; closing the Account itself does not revoke or demote Memberships.

## Planned Account Capabilities And Channel Connections

These planned terms pre-register upcoming account capability, store team, and external channel connection language. They are not shipped behavior until Identity adds the corresponding consent, membership, authorization, and account-management facts.

### Account Capability

An **Account Capability** is the planned account-level ability to use a marketplace or integration workflow.

### Capability Grant

A **Capability Grant** is the planned fact that an Account has been approved for an Account Capability.

### Capability Restriction

A **Capability Restriction** is the planned fact that limits or suspends an Account Capability.

### Capability Requirement

A **Capability Requirement** is the planned prerequisite an Account must satisfy before a Capability Grant.

### Capability Level

A **Capability Level** is the planned graduated operating range for an Account Capability.

### Account Standing

**Account Standing** is the planned account-level eligibility posture used by capability, trust, and policy decisions.

### Capability Status

**Capability Status** is the planned lifecycle state of an Account Capability.

### Capability Review

**Capability Review** is the planned workflow that evaluates whether an Account should receive, keep, or lose a Capability Grant.

### Sales Channel

A **Sales Channel** is the planned external or native commerce surface connected to an Account.

### Channel Connection

A **Channel Connection** is the planned linked relationship between a Chase Sets Account and a Sales Channel.

### BYO Channel

A **BYO Channel** is the planned account-supplied Sales Channel connection that Chase Sets supports without owning the external storefront.

### Channel Account

A **Channel Account** is the planned external account identity linked to a Chase Sets Account for a Sales Channel.

### Channel Authorization

A **Channel Authorization** is the planned consent that allows Chase Sets to act with scoped access on a Sales Channel.

### Channel Credential

A **Channel Credential** is the planned secret or token reference used to access a Sales Channel.

### Channel Webhook

A **Channel Webhook** is the planned inbound event subscription configured for a Sales Channel.

### Channel Health

**Channel Health** is the planned account-visible operational state of a Sales Channel connection.

### Channel Mapping

A **Channel Mapping** is the planned account-owned configuration that maps channel fields, SKUs, locations, or policies to Chase Sets terms.

### Store Team

A **Store Team** is the planned group of Memberships that can operate a Store.

### Store Role

A **Store Role** is the planned role assignment that scopes a Membership's authority within a Store.

### Store Invitation

A **Store Invitation** is the planned request for a User or email address to join a Store Team.

## Language Rules

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
