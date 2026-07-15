# Auth Bounded Context

## Purpose

Auth owns the authentication journeys that let a user start, continue, and end an authenticated session in Chase Sets.

It is the canonical home for:

- sign-in flows
- registration flows
- account-selection continuation
- sign-out behavior
- browser session cookie conventions
- session lifecycle and revocation
- actor-resolution helpers used by hosts
- the mounted Auth API at `/api/auth`
- phone-code and email-link challenge journeys
- invitation inspection, credential setup, and authenticated acceptance journeys

## Owns

- Authentication journeys
- Browser session lifecycle and persistence
- Account-selection continuation during sign-in
- Session-cookie and return-path behavior
- Session-token and account-selection-token persistence
- Auth-specific credential and challenge persistence
- Auth notification intents for security challenges
- Host-facing auth route modules
- Auth API routes and orchestration

## Does Not Own

- User profile management
- Account profile management
- Membership administration
- Invitations
- Consents
- API key management

Those remain in Identity.

## Ubiquitous Language

Auth terminology is defined in [GLOSSARY.md](./GLOSSARY.md).
Magic-link request, delivery, and consumption security is documented in [Magic Link Security](./docs/magic-link-security.md).
Signed agent order-update callback registration, verification, and staging proof are documented in [Agent order-update webhooks](./docs/agent-webhooks.md).
Social Login journey rules and context ownership are documented in [Social Login](./docs/social-login.md).
Session/token security lifetimes -- values, env vars, bounds, and the env-tier-by-design exclusion from admin policy -- are documented in [Security Lifetimes](./docs/security-lifetimes.md).

## Core Aggregates and Process Managers

- Session

## Incoming Dependencies

- Identity for user, account, membership, and invitation facts, projected into auth-owned tables for local reads (`auth-identity-account-projection`, `auth-identity-user-projection`, `auth-identity-membership-projection`, `auth-identity-invitation-projection`).
- Identity's `@chase-sets/identity/server` for the narrow synchronous identity mutations that still belong to Identity.
- Ordering, Fulfillment, and Payments order/shipment/refund facts, consumed only by the optional agent-webhook projection once all three source contexts are mounted.

## Outgoing Integration Events

- None. `auth.session.started`, `auth.session.account-switched`, `auth.session.revoked`, and `auth.session.expired` are consumed only by Auth's own session projection today.

## Invariants

1. A session aggregate can be started only once; starting an already-started session is rejected.
2. Switching account, revoking, or expiring a session requires an active session.
3. Switching a session's account requires the target account to already be listed in the session's available accounts and to differ from the current account.
4. Auth resolves the actor for hosts; Identity remains the sole owner of the underlying user, account, membership, and permission facts an actor carries.
5. Social Login may auto-link by email only when the provider proves email ownership; otherwise linking requires an authenticated existing-user continuation.
6. Dynamic Client Registration accepts only public OAuth clients; Auth does not issue, store, or echo client secrets.
7. Invitation acceptance requires the emailed bearer token, consumes it through Identity exactly once, and starts the resulting session in the invited account with the invited role.

## Tests

Run `pnpm --filter @chase-sets/auth run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/auth run test` before opening a PR.

## Current Boundary

Auth is the canonical home for interactive authentication behavior, session persistence, session-token persistence, and the `/api/auth` surface.

Identity remains upstream for:

- users
- accounts
- memberships
- invitations
- consent records
- the user and account facts that Auth needs to resolve an actor

That means:

- Auth owns the browser and API authentication journey.
- Auth owns session start, session revoke, session lookup, and actor resolution.
- Identity owns the underlying account and membership facts that Auth needs to finish authentication.
- Auth reads identity facts through auth-owned projections and issues the small remaining synchronous identity mutations through `@chase-sets/identity/server`.

## Feature vs Composition

- **Feature code stays in Auth slices.** Authentication behavior, domain rules, query code, and projections live in Auth-owned feature slices under `bounded-contexts/auth/features/`.
- **`routes/` is adapter-only.** `bounded-contexts/auth/routes/` should only host deployable adapter modules that bind route exports to slice-local features.
- **`support/` is composition-only.** Keep API composition, request helpers, and shared journey UI under `bounded-contexts/auth/support/*-support/`; do not place feature domain/query/projection code there.
- **Deployables remain thin roots.** Deployables should resolve Auth route and shell contributions through `@chase-sets/platform-runtime`, then delegate to Auth-owned route modules.

## Flexible Sign-In

Auth supports multiple authentication methods for marketplace registration and sign-in:

- Passkey
- Phone Code
- Magic link
- Password
- Social Login

Phone Code delivery goes through the provider-neutral Notifications contract and the Auth-owned notification outbox. Platform worker adapters handle SMS provider details, including local noop delivery and Twilio delivery when mobile messaging is configured.

See [docs/flexible-sign-in.md](./docs/flexible-sign-in.md) for route and ownership details.
