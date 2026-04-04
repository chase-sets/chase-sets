# Auth Glossary

## Authentication

The process of proving who a user is so Chase Sets can create or continue a session.

## Authorization

The process of deciding what an authenticated actor is allowed to do after authentication succeeds.

Authorization is downstream of Auth. Auth may help resolve the actor, but it does not own business permissions.

## Session

The authenticated browser or API interaction window that lets a user continue acting without signing in again on every request.

Auth owns the interactive session lifecycle and the session token that resumes it.

## Session Token

The secret value that identifies the active session when sent back to Chase Sets.

Session-token persistence belongs to Auth even when the underlying account-scoped session record is still coordinated with Identity.

## Account Selection

The continuation step used when one authenticated user can act for more than one account and must choose which account to use for the current session.

## Actor

The authenticated execution identity used by hosts and APIs after session resolution. An actor includes the selected account context and permission set.

Auth resolves the actor for hosts. Identity remains upstream for the user, account, membership, and permission facts included in that actor.

## Return Path

The safe in-app path that Auth sends the user back to after sign-in, registration, or account selection completes.
