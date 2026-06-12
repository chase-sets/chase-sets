# Cookie-Backed Continuation Handoff

## Purpose

A Cookie-Backed Continuation Handoff is any browser route action that creates, clears, rotates, or switches cookie-backed identity or authorization state, then sends the user to a route whose loader depends on that changed cookie.

Examples include guest checkout contact submit, sign-in, registration, account selection, social login callbacks, guest payment claim, and magic-link or passkey claim continuations.

The pattern exists to prevent a partial-success failure mode: the server creates durable state and returns `Set-Cookie`, but the first protected destination loader does not see the new cookie and renders a generic server error. Refresh may appear to fix the page, but the user has already lost trust because the workflow looked broken after state was created.

## Required Behavior

When a route action mutates auth-like cookies and the next route depends on those cookies, the action must return a document-level redirect. In React Router route modules, use `redirectDocument` or an equivalent response that forces the browser to commit `Set-Cookie` before loading the destination document.

Do not pass session, guest, claim, account-selection, auth, or payment-claim tokens through query strings, URL fragments, local storage, client state, or client-readable cookies. These values must remain server-issued and HttpOnly unless a separate security review explicitly changes the contract.

The destination loader must classify expected protected-resource failures:

- `401`: missing, expired, revoked, or not-yet-active authentication context.
- `403`: authenticated actor cannot access the requested resource, including wrong-account access.
- `404`: resource does not exist or is not visible to the actor.

Expected protected-resource failures must return route-owned recovery UI or a safe redirect. They must not escape to the root error boundary as `500`.

Root error-boundary copy must only claim facts that are true for unknown failures. Route-level recovery copy should be precise. For example, checkout recovery may say payment has not started before checkout confirmation, but it must not claim no account or checkout changes happened after guest identity or checkout-session creation may have succeeded.

Read-after-write helpers handle projection or read-model lag. They are not a substitute for browser cookie handoff correctness.

If the destination loader also reads projection-backed data immediately after the write, preserve the `afterWrite` token across the document-level redirect and follow the [Read-After-Write Route Author Checklist](./read-after-write-route-author-checklist.md). Cookie visibility and projection freshness are separate requirements; guest checkout contact submit needs both.

## Implementation Checklist

- Identify the cookie being created, cleared, rotated, or switched.
- Identify the destination loader and the exact cookie-backed actor, account, guest, or claim state it depends on.
- Use document-level redirect when the destination loader depends on the changed cookie.
- Preserve any read-after-write token used for projection freshness.
- Declare exact `readFreshnessRoutes` dependencies and route inventory metadata when the destination reads a projection-backed API resource.
- Keep sensitive tokens out of URLs and client-readable state.
- Catch expected API errors in the destination route and map them to route-owned recovery.
- Keep unknown failures visible as real errors.
- Use copy that distinguishes durable state already created from side effects that have not started.
- Verify no downstream side effect occurs before its explicit confirmation step.

## Test Checklist

Every cookie-backed continuation should have tests covering:

- Action response uses document-level redirect when required.
- `Set-Cookie` includes the expected cookie value and clearing behavior.
- Cookie attributes match environment conventions, including `HttpOnly`, `SameSite`, and `Secure` where applicable.
- Destination loader succeeds with the new cookie.
- Destination loader handles missing cookie.
- Destination loader handles expired, revoked, malformed, or wrong-token state.
- Destination loader handles protected API `401`, `403`, and `404`.
- Expected protected-resource failures do not render the root error boundary or HTTP `500`.
- Sensitive tokens do not appear in URLs, fragments, local storage, client state, or client-readable cookies.
- Downstream side effects are not created before the required confirmation step.

## Guest Checkout Example

Guest checkout contact submit creates a guest checkout token and checkout session, then redirects to `/checkout/buy/session/:sessionId`. The checkout-session loader depends on the `chase_sets_guest_checkout` cookie to resolve the guest actor and read the session.

The route action must use document-level redirect after setting `chase_sets_guest_checkout`. The checkout-session loader must handle missing, expired, wrong-account, and not-found cases with checkout-owned recovery UI. Before checkout confirmation, recovery copy may say payment has not started.

## Other Common Examples

Sign-in and registration create an authenticated session cookie before returning to protected account routes. The return route must not depend on client-side state to see the new session.

Account selection switches the account context for an authenticated user before returning to an account-scoped route. Wrong-account or missing-selection failures should lead to account-selection recovery, not a generic server error.

Social login callbacks create or continue session state after provider verification. Provider callback tokens and session tokens must stay out of return URLs.

Guest payment claim flows use guest checkout state before showing `/checkout/payments/:paymentId`. Expired or revoked guest claim access should show payment-owned recovery that states whether a payment was charged or not charged.

Magic-link and passkey claim continuations consume short-lived challenges before issuing session state. They must preserve single-use token semantics and use safe return paths.
