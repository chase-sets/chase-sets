# Flexible Sign-In

Auth owns the interactive registration and sign-in journeys. Identity owns the durable User, Contact Method, Verification, Authentication Method, Account, and Membership facts those journeys use.

## Supported Methods

- Passkey
- Phone Code
- Magic link
- Password
- Social Login

Marketplace registration keeps passkey as the first path, but phone code, email magic link, password, and social login are first-class alternatives.

## Phone Code

A phone-code journey starts with `/api/auth/phone-code/request`. Auth normalizes the phone number, stores a short-lived challenge, and enqueues a security notification through `notification_outbox` with an `sms` channel.

The code is consumed through `/api/auth/phone-code/consume`. Existing users are resolved through Auth's Identity projection phone lookup. Unknown users are created only after the code is verified, at which point Identity records the verified phone Contact Method and enables the `sms-code` Authentication Method.

Auth must not call SMS providers directly. Platform worker dispatches notification outbox deliveries through noop adapters locally or Twilio adapters when mobile messaging is configured.

## Email Compatibility

Email magic link, password, and passkey flows remain available. Existing email-backed users continue to project into Auth email lookup tables, while phone-backed users may have no primary email.
