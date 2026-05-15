# Flexible Sign-In

## Intent

Allow marketplace users to register and sign in with phone, email, or other authentication methods without making email the only user identifier in Auth-owned journeys.

This plan treats "phone" as a first-class Identity contact method and an Auth sign-in identifier, not as a profile-only field. It keeps the deployables thin and puts behavior in the Auth and Identity bounded contexts.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-flexible-sign-in`
- Branch: `codex/flexible-sign-in`
- Base: rebased onto `origin/main` at `7da38ab2` on 2026-05-15 after SMS/RCS notification support landed.
- Sandbox id: `a9a0fe8d`
- Dependency setup: `pnpm run deps:install` completed successfully before planning and again after rebase. The rebased workspace now has 59 projects.
- Sandbox doctor: `pnpm run sandbox:doctor` completed successfully before planning and again after rebase.
- Local services:
  - Marketplace: `http://localhost:7653`
  - Platform API: `http://localhost:7662`
- Setup blockers: none.

## Owning Contexts

### Auth

Auth owns the interactive journeys and API behavior:

- registration flow
- sign-in flow
- session start and account-selection continuation
- auth challenge and token persistence
- browser route modules and Auth API under `/api/auth`

Repo evidence:

- `bounded-contexts/README.md` says Auth owns sign-in, sign-out, registration, session lifecycle, and session-entry journeys.
- `bounded-contexts/auth/README.md` makes Auth the canonical home for authentication journeys and the mounted `/api/auth` surface.
- `bounded-contexts/auth/context.json` declares the `registration`, `sign-in`, `sessions`, and `account-selection` slices.

### Identity

Identity owns the durable user facts needed by those journeys:

- User
- Contact Method
- Verification
- Authentication Method
- Credential references
- Account and Membership facts needed after authentication

Repo evidence:

- `bounded-contexts/identity/README.md` says Identity owns users, contact methods, verifications, and authentication methods, and explicitly does not own sign-in or registration.
- `bounded-contexts/identity/GLOSSARY.md` defines Contact Method as "a way to reach or verify a user" with email address and phone number examples.
- `bounded-contexts/identity/support/runtime-support/common.ts` already includes `ContactMethodType = "email" | "phone"`.

### Notifications And Infrastructure

SMS delivery should stay outside Auth domain logic:

- Auth should emit/request a phone challenge or phone-code intent.
- Infrastructure should adapt provider-specific SMS delivery.
- The rebased main line includes provider-neutral `sms` and `rcs` notification channels, a durable notification outbox, Twilio SMS/RCS adapters, webhook normalization, and noop mobile-message adapters for local/dev/test.
- SMS/RCS should remain constrained for cost and compliance.

Repo evidence:

- `contracts/notifications/index.ts` defines `SmsNotificationChannel`, `RcsNotificationChannel`, `NotificationOutbox`, `NotificationChannelAdapter`, and noop adapters.
- `infrastructure/notification-outbox/index.ts` owns durable notification delivery rows and dispatch retry behavior.
- `infrastructure/twilio-messaging/index.ts` adapts `sms` and `rcs` notification channels to Twilio Programmable Messaging and verifies Twilio webhooks.
- `deployables/platform-worker/src/main.ts` configures Twilio `sms`/`rcs` adapters when `MOBILE_MESSAGING_PROVIDER=twilio`, otherwise uses noop adapters.
- `docs/architecture/notifications-channel-and-provider-recommendation.md` now says the first SMS/RCS implementation uses provider-neutral channels in the Notifications contract and `infrastructure/twilio-messaging`.

## Resolved Decisions

- Auth remains the behavior owner for the registration and sign-in journeys.
- Identity remains the source of truth for Contact Method and Authentication Method.
- The canonical user-facing language should avoid "email" as the generic identity prompt. Use a term such as "email or phone" in UI copy where the concrete input accepts only those identifiers, and reserve "Authentication Method" for the durable Identity concept.
- "Phone" should be modeled as a Contact Method with verification, not as a separate User type or Account capability.
- Deployables should only compose route exports; new behavior should live in bounded-context slices/support.
- Existing email-first storage and route contracts are the main entropy source to reduce.
- Phone registration and sign-in will be implemented with SMS one-time codes in this slice.
- OAuth/social login is a future authentication-method extension and is not part of this first phone/email implementation.
- Normalized phone numbers used for registration or sign-in are globally unique sign-in identifiers.
- Phone registration creates the User, Account, Membership, verified phone Contact Method, and `sms-code` Authentication Method only after the submitted SMS code is verified.
- SMS delivery uses the existing provider-neutral Notifications contract and `notification_outbox`; Auth must not introduce a parallel SMS port or direct Twilio dependency.
- Local/dev/test SMS delivery should use the existing noop notification adapters unless a test needs an in-memory/assertable notification outbox.
- Marketplace registration keeps passkey as the first/default registration path, with phone code, email link, and password presented as other ways.

## Current Repo Findings

- `bounded-contexts/auth/features/registration/ui/register-page.tsx` stores registration details as `displayName`, `email`, and `password`, and all registration methods require an email input.
- `bounded-contexts/auth/features/sign-in/ui/sign-in-page.tsx` supports password, magic link, and passkey sign-in, but each path asks for `email`.
- `bounded-contexts/auth/support/api-support/register-routes.ts` creates a personal identity with `email`, checks existing users by email, and starts a session with `password` or `magic-link`.
- `bounded-contexts/auth/support/api-support/password-routes.ts` only accepts `email` for user lookup.
- `bounded-contexts/auth/support/api-support/magic-link-routes.ts` persists an email-specific magic-link token and creates email-backed users when needed.
- `bounded-contexts/auth/support/api-support/passkey-routes.ts` binds passkey challenge lookup to `email`.
- `bounded-contexts/auth/support/auth-support/store.ts` has email-specific magic-link and passkey challenge columns.
- `bounded-contexts/identity/features/users/domain/domain.ts` has generic contact-method events, but `CreateUser` still requires `primaryEmail`.
- `bounded-contexts/identity/features/users/read-model/schema.ts` requires `primary_email` and has an `identity_user_emails` lookup table, but no phone lookup table.
- `bounded-contexts/auth/support/auth-support/identity-projection.ts` mirrors Identity users into Auth, including email lookups only.
- `bounded-contexts/identity/support/runtime-support/seed.ts` already seeds a phone contact method, proving the domain type exists but current Auth journeys cannot use it.
- `bounded-contexts/identity/support/runtime-support/common.ts` limits durable auth methods to `password`, `magic-link`, and `passkey`; SMS code is glossary-level only today.
- Rebased main at `7da38ab2` adds provider-neutral `sms`/`rcs` notification channels and Twilio/noop worker dispatch, so this feature should reuse `@chase-sets/notifications` plus `@chase-sets/notification-outbox`.
- Auth currently has a `transactionalEmailOutbox` host port only; phone-code SMS likely needs an Auth-owned `notificationOutbox` host port so the platform worker can dispatch Auth security SMS messages using the existing notification dispatcher.

## Resolved Questions

### 1. Initial Phone Authentication Scope

Decision needed: Should the first phone-based flow be SMS one-time code for registration and sign-in?

Answer: Yes. Add SMS one-time code as the initial phone authentication method for registration and sign-in, while keeping passkey, email magic link, and password available. Treat OAuth/social login as a later plug-in-style authentication method.

Why it matters:

- This determines whether implementation adds a new Auth authentication method (`sms-code`) and phone-code challenge/token storage now, or only changes UI copy and identifier normalization while delaying actual phone sign-in.
- It also determines how Auth should use the provider-neutral notification channel support that now exists on main.

Recommended answer:

- Yes. Add SMS one-time code as the initial phone authentication method for registration and sign-in, while keeping passkey, email magic link, and password available. Treat OAuth/social login as a later plug-in-style authentication method, documented in the plan but not implemented in this slice.

Repo evidence:

- Identity already models phone as a Contact Method.
- Identity glossary lists SMS code as an Authentication Method example.
- Current Auth routes and UI are email-specific, so a real phone option requires a new route path and lookup/projection behavior, not just copy changes.
- Notification provider guidance already points to Twilio for SMS/RCS, but warns against broad SMS use for margin reasons.

Consequence of choosing differently:

- If we defer SMS code, "phone sign-up" would be a cosmetic form change and would not satisfy users who prefer phone over email.
- If we include OAuth/social login in this same first slice, the scope expands across provider config, callback security, account linking, and credential storage before the phone/email identifier model is clean.

### 2. Phone Uniqueness For Sign-In

Decision needed: Should a normalized phone number be globally unique across users once it is used for registration or sign-in?

Answer: Yes. A normalized phone number resolves to one user. Registration with an existing phone routes to sign-in or recovery instead of creating a duplicate User.

Why it matters:

- Sign-in needs a deterministic way to resolve one user from one phone number.
- Email already behaves this way through `identity_user_emails.email` and `auth_identity_user_emails.email` primary-key lookup tables.
- Identity currently prevents duplicate contact methods inside one User aggregate, but there is no global phone lookup table yet.

Recommended answer:

- Yes. Treat normalized email addresses and normalized phone numbers as globally unique sign-in identifiers. Registration with an existing phone should route to sign-in/recovery, not create another User. Later account/team sharing still happens through Memberships and Invitations, not shared phone numbers.

Repo evidence:

- Identity glossary says Users sign in and Accounts do not sign in.
- Identity models Membership separately, so multiple people acting for the same Account should have separate Users and separate contact methods.
- Email lookup tables already use primary-key uniqueness to avoid ambiguous user resolution.

Consequence of choosing differently:

- Allowing the same phone on multiple users makes SMS sign-in ambiguous and would require an account/user disambiguation step before authentication, which increases fraud and support complexity.
- Allowing unverified duplicate phone numbers but verified unique phone numbers is possible, but it requires pending-contact lifecycle rules that are broader than the current registration request.

### 3. Phone Registration Creation Point

Decision needed: Should phone-based registration create the User only after the submitted SMS code is verified?

Answer: Yes. Auth issues the SMS challenge first. Identity user/account/membership facts are created only after code verification succeeds.

Why it matters:

- Creating users before code verification leaves abandoned Identity users, accounts, and memberships for mistyped or unreachable phone numbers.
- Existing email magic-link behavior delays unknown-user creation until the magic link is consumed, not when the email is requested.
- Event sourcing makes abandoned events durable; cleanup would need compensating lifecycle behavior rather than a simple delete.

Recommended answer:

- Yes. Issue an Auth-owned phone challenge first. Only after successful code consumption should Auth call Identity to create the personal identity, add the phone Contact Method, mark it verified, enable `sms-code`, and start the session.

Repo evidence:

- `bounded-contexts/auth/support/api-support/magic-link-routes.ts` creates unknown users on token consumption.
- `bounded-contexts/identity/features/users/domain/domain.ts` has `AddContactMethod`, `VerifyContactMethod`, and `EnableAuthMethod` commands that can express the post-verification facts.
- `bounded-contexts/identity/api.ts` currently creates users and accounts together for Auth-owned personal identity creation, so changing the creation point is the lowest-entropy place to avoid abandoned account roots.

Consequence of choosing differently:

- Creating the User before verification may make the UI simpler, but it creates durable unverified identities and account memberships for failed SMS delivery, typoed phone numbers, and bot attempts.
- Creating a temporary Identity aggregate would require a new pending-user lifecycle that is bigger than the registration/sign-in slice.

### 4. SMS Delivery Adapter Scope

Decision needed: Should this slice create its own SMS delivery adapter, or reuse the rebased main notification channel/outbox support?

Answer: Reuse the provider-neutral SMS/RCS notification support from rebased main. Auth should enqueue phone-code security messages through the existing Notifications contract and notification outbox. Twilio is already a configured infrastructure adapter, and noop adapters already cover local development without Twilio credentials.

Why it matters:

- Real SMS authentication is only useful in staging/production if a dispatcher and adapter exist, and rebased main now provides both.
- Auth should not depend directly on a provider SDK; provider details already belong in `infrastructure/twilio-messaging` and deployable configuration.
- US A2P 10DLC requirements mean production SMS cannot be treated like a free-form dev email outbox.

Recommended answer:

- Add an Auth phone-code notification intent that maps to `NotificationMessage` with an `sms` channel and enqueue it through a context-owned notification outbox. Do not create a new SMS contract, new Twilio adapter, or Auth-to-Twilio dependency.

Repo evidence:

- `contracts/notifications/index.ts` already defines `SmsNotificationChannel` with E.164 recipients.
- `infrastructure/notification-outbox/index.ts` already supports any notification channel and retrying dispatch.
- `infrastructure/twilio-messaging/index.ts` already sends `sms`/`rcs` deliveries and normalizes provider webhooks.
- `deployables/platform-worker/src/main.ts` already registers Twilio adapters when configured and noop mobile-message adapters otherwise.
- Current email magic-link delivery uses a provider-agnostic transactional email outbox; phone-code delivery should follow the same dependency direction using the generalized notification outbox now available.

Current external evidence checked on 2026-05-15:

- Twilio's A2P 10DLC docs describe registration through Console or API and throughput/registration considerations for US messaging: https://www.twilio.com/docs/messaging/compliance/a2p-10dlc
- Twilio's A2P quickstart says US regulations require A2P 10DLC registration to send from a US 10DLC number to US recipients: https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart
- AWS End User Messaging pricing docs list SMS/OTP pricing behavior, making AWS a viable benchmark but not the repo's current recommendation: https://aws.amazon.com/end-user-messaging/pricing/

Consequence of choosing differently:

- If Auth creates its own SMS port now, the platform will have two mobile-delivery abstractions and two retry/adapter paths.
- If Auth calls Twilio directly, provider concerns leak into the bounded context and bypass existing delivery retry and webhook infrastructure.
- If we switch to AWS in this slice, we contradict the existing architecture recommendation without enough platform evidence to justify the change.

### 5. Marketplace Default Entry Method

Decision needed: Should marketplace registration and sign-in make phone code the default visible path?

Answer: No. Keep passkey as the first registration path and add phone as another first-class option alongside email link and password.

Why it matters:

- The request is motivated by users preferring phone number over email address.
- Current registration defaults to passkey and current sign-in defaults to password, while every current method asks for email.
- UI default order affects conversion more than merely adding a hidden fallback.

Recommended answer:

- Yes. Make phone code the default marketplace registration and sign-in path, with email link, passkey, and password presented as other sign-in ways. Keep passkeys available and encouraged after account creation, but do not make passkey setup block phone-first registration.

Repo evidence:

- `bounded-contexts/auth/features/registration/ui/register-page.tsx` currently defaults to `passkey`.
- `bounded-contexts/auth/features/sign-in/ui/sign-in-page.tsx` currently defaults to `password`.
- The design-system guidance supports segmented controls, icons, and clear method switching without custom UI overrides.

Consequence of choosing differently:

- If phone is not the default visible path, the implementation technically supports phone but may not help the users this request targets.
- If passkey remains the first registration path, anonymous passkey setup still needs an identifier, and the current implementation is email-oriented.

Accepted trade-off:

- Passkey remains the preferred marketplace registration posture for security and continuity with the current UX, but the implementation must still remove email as the only identifier and make phone code visibly available from registration and sign-in.

## Implementation Checklist

- Update Identity user creation so a user can be created with a primary contact method instead of a required primary email, while preserving email compatibility.
- Add Identity read-model lookup support for phone contact methods.
- Add Auth identity projection support for phone lookups and generic contact-method matching.
- Introduce Auth sign-in identifier parsing/normalization for email vs phone, with E.164-friendly phone normalization and validation.
- Add `sms-code` auth method and phone-code challenge/token persistence.
- Add phone registration and sign-in API routes, with replay-safe challenge consumption and rate-limit hooks.
- Add Auth phone-code notification intent mapping to the existing provider-neutral `NotificationMessage`/`sms` channel.
- Add an Auth `notificationOutbox` host port if Auth owns phone-code delivery, so the existing platform-worker notification dispatcher can send Auth security SMS.
- Keep email magic link, passkey, and password flows working during migration.
- Update marketplace registration and sign-in UI to use design-system components and a first-class method picker for phone, email, passkey, password, and future "other ways" extension.
- Keep passkey as the default registration path, but make phone code a first-class visible alternative in registration and sign-in.
- Add or update tests for Identity domain/read-model/projection, Auth route behavior, Auth UI, localization keys, and host route form handling.
- Add mobile and desktop visual verification for marketplace registration/sign-in.
- Document rollout and provider/config expectations, including noop local SMS behavior and the existing Twilio `MOBILE_MESSAGING_PROVIDER=twilio` production configuration.

## Stress Tests

- Normal flow: new user registers with phone, verifies SMS code, receives a session, and lands on the safe return path.
- Existing email user: user can still sign in by email magic link, password, or passkey.
- Existing phone contact: user with a verified phone contact can sign in by SMS code without creating a duplicate user.
- Duplicate contact: adding/registering a phone number already owned by another user is rejected or routed to sign-in.
- Replay: consumed SMS codes cannot be reused; expired codes fail without starting a session.
- Multi-account: after phone authentication, account selection still works for users with multiple memberships.
- Partial delivery: failed SMS delivery does not create an authenticated session and exposes a recoverable fallback.
- Migration: users with only `primary_email` remain queryable by email after any schema changes.
- Cost/compliance: SMS is constrained to authentication/security, not general marketing or low-value engagement loops.

## Documentation To Promote

- Add an Auth context doc for flexible identifiers and phone-code authentication if Question 1 is accepted.
- Update `bounded-contexts/auth/GLOSSARY.md` with any Auth-local terms such as Sign-In Identifier or Phone Code.
- Update `bounded-contexts/identity/GLOSSARY.md` only if implementation introduces a durable term beyond existing Contact Method, Verification, and Authentication Method.
- Update `docs/GLOSSARY.md` only for cross-context terms that become product/API language.
- Consider an ADR only if we change the existing SMS provider direction or make a hard-to-reverse account-linking policy in this slice.

## Goal Completion Criteria

The later implementation goal must:

- Work only in `D:\Users\ToddS\Source\Repos\chase-sets-20260515-flexible-sign-in` on branch `codex/flexible-sign-in`.
- Implement the settled phone/email/other-auth plan inside owning bounded contexts, with deployables staying as thin composition roots.
- Promote durable docs to the owning context docs/glossaries.
- Retain this `.codex/plans/20260515-flexible-sign-in.md` file with final decisions.
- Run focused automated tests for changed contexts plus any affected generated composition checks.
- Run mobile and desktop visual verification for marketplace registration and sign-in.
- Submit a PR.
- Get CI passing.
- Merge the PR.
- Verify the staging deploy registration and sign-in flows after merge.

Goal status:

- Implementation goal created on 2026-05-15 for this rebased worktree, branch, and retained plan.
- Implementation completed locally on 2026-05-15 through focused Auth, Identity, design-system, localization, metadata, typecheck, and mobile/desktop visual verification.
- Remaining delivery work: publish PR, monitor CI, merge, and verify staging after deployment.
