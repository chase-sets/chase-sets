# Auth Glossary

## Authentication

The process of proving who a user is so Chase Sets can create or continue a session.

## Authorization

The process of deciding what an authenticated actor is allowed to do after authentication succeeds.

Authorization is downstream of Auth. Auth may help resolve the actor, but it does not own business permissions.

## Session

The authenticated browser or API interaction window that lets a user continue acting without signing in again on every request.

Auth owns the interactive session lifecycle, the session aggregate, and the session token that resumes it.

## Session Token

The secret value that identifies the active session when sent back to Chase Sets.

Session-token persistence belongs to Auth.

## Account Selection

The continuation step used when one authenticated user can act for more than one account and must choose which account to use for the current session.

## Actor

The authenticated execution identity used by hosts and APIs after session resolution. An actor includes the selected account context and permission set.

Auth resolves the actor for hosts. Identity remains upstream for the user, account, membership, and permission facts included in that actor.

## Return Path

The safe in-app path that Auth sends the user back to after sign-in, registration, or account selection completes.

## Sign-In Identifier

A **Sign-In Identifier** is the contact value Auth accepts to start an authentication journey.

Examples:

- Email address
- Phone number

Notes:

- Identity owns the durable Contact Method facts for a user.
- Auth owns how a sign-in identifier is normalized, challenged, consumed, and converted into a session.
- A normalized sign-in identifier must resolve to one user before it can continue an existing-user journey.

## Phone Code

A **Phone Code** is a short-lived Auth challenge sent to a phone number and consumed to start or continue a session.

Notes:

- Phone Code delivery uses the provider-neutral Notifications contract with the `sms` channel.
- Auth persists and consumes the challenge; it does not call Twilio or any other SMS provider directly.
- A phone-based registration creates Identity user, account, membership, verified phone Contact Method, and `sms-code` Authentication Method facts only after code verification succeeds.

## Checkout Registration Continuation

A **Checkout Registration Continuation** is the Auth-owned registration journey that returns a signed-in account to an in-progress checkout source intent.

Notes:

- Passkey is the default registration method for purchase-intent checkout, with magic link available as the passwordless fallback.
- Checkout owns the purchase-intent workflow state; Auth owns registration, authentication method selection, session creation, account selection, and safe return paths.

## Social Login

A **Social Login** is an Auth-owned sign-in or registration journey that uses an external identity provider account to authenticate a user.

Notes:

- Google and Facebook are the first supported Social Login Providers.
- Auth owns provider redirect state, callback verification, safe return paths, session creation, and account-selection continuation.
- Identity owns the durable user-level Social Login Link that records which provider identity can authenticate a user.
- Social Login must not create or link a user unless the provider returns a verified email address.

## Social Login Provider

A **Social Login Provider** is an external identity provider configured for Social Login.

Examples:

- Google
- Facebook

Provider access tokens, client secrets, and raw provider payloads are integration details. They must stay out of Auth session events and Identity user events.

## OAuth Authorization

An **OAuth Authorization** is the Auth-owned user journey that lets a user select an account and grant delegated UCP access to an external platform.

Notes:

- Auth owns authorization, account selection, token-facing actor resolution, and safe return paths.
- Identity owns the durable Linked Platform Authorization consent and revocation facts.

## Dynamic Client Registration

**Dynamic Client Registration** is the Auth-owned OAuth endpoint that lets an agent platform register a public PKCE client for UCP access.

Notes:

- Auth accepts only public clients and does not issue, store, or echo client secrets.
- Registered redirect URLs, client/profile URLs, and scopes bound what the later OAuth Authorization request may use.

## Client ID Metadata Document

A **Client ID Metadata Document** is a trusted URL used as an OAuth `client_id` whose JSON metadata describes the public client.

Notes:

- Auth resolves the document during OAuth Authorization and applies the same public-client, redirect URL, and scope constraints used for Dynamic Client Registration.
