# Magic Link Security

Auth owns magic-link request, delivery, consumption, and session creation.

Magic-link request responses must not expose the raw magic-link secret to browser clients. The request endpoint stores only the hashed token for consumption and stores the short-lived delivery token in mutable Auth token storage for the transactional email projector. The `auth.magic-link.requested` event publishes request facts such as token ID, user ID, email, expiry, and non-secret host landing metadata; it must not publish token secrets, token hashes, or delivery tokens.

Browser sign-in surfaces show an email-only success state after requesting a magic link. They must not render same-browser local recovery actions, hidden token consume forms, or manual token entry unless an Auth host explicitly enables that capability for a non-production test surface.

Admin Auth hosts must keep manual magic-link token entry disabled. A submitted `magic-link-consume` form on those hosts is rejected before calling the Auth API, so hiding the control is not the only protection.

The host landing routes (`/sign-in/magic` and `/access/sign-in/magic`) consume email-delivered tokens through `/api/auth/magic-link/consume`. The consume endpoint must continue to enforce token hashing, expiry, single-use consumption, and normal membership/account-selection checks before a session is created.
