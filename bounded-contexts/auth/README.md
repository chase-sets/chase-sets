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

## Owns

- Authentication journeys
- Browser session lifecycle
- Account-selection continuation during sign-in
- Session-cookie and return-path behavior
- Host-facing auth route modules

## Does Not Own

- User profile management
- Account profile management
- Membership administration
- Invitations
- Consents
- API key management

Those remain in Identity.

## Current Boundary

Auth currently orchestrates the sign-in journey against the Identity API because Identity still owns the underlying account, membership, and session records.

That means:

- Auth owns the user journey and host-facing auth helpers.
- Identity owns the underlying identity data and management behavior.
- Deployables compose Auth routes and Identity feature routes separately.

## Extraction Direction

Long term, the underlying session and credential records may move fully into Auth if that reduces coupling further.

For now, Auth is already the canonical bounded context for authentication behavior and deployable integration.
