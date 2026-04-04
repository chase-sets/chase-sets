# Auth Bounded Context

## Purpose

Auth owns the authentication journeys that let a user start, continue, and end an authenticated session in Chase Sets.

It is the canonical home for:

- sign-in flows
- registration flows
- account-selection continuation
- sign-out behavior
- browser session cookie conventions
- actor-resolution helpers used by hosts
- the mounted Auth API at `/api/auth`

## Owns

- Authentication journeys
- Browser session lifecycle
- Account-selection continuation during sign-in
- Session-cookie and return-path behavior
- Session-token and account-selection-token persistence
- Auth-specific credential and challenge persistence
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

## Current Boundary

Auth is the canonical home for interactive authentication behavior, session-token persistence, and the `/api/auth` surface.

Identity remains upstream for:

- users
- accounts
- memberships
- invitations
- consent records
- the account-scoped session record that Auth activates or revokes

That means:

- Auth owns the browser and API authentication journey.
- Identity owns the underlying account and membership facts that Auth needs to finish authentication.
- Auth may depend on Identity only through `@chase-sets/identity/integration`.
