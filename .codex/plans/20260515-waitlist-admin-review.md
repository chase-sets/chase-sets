# Waitlist Join Notification And Admin Review

## Intent

Public landing page visitors should receive a clear confirmation that they have officially joined the waitlist, and platform admins should be able to find and review waitlist signups from the admin web surface.

The implementation should preserve bounded-context ownership:

- Public Presence owns Waitlist Signup behavior, waitlist read models, waitlist admin review UI, and source facts.
- Notifications owns signed-in account notification-center behavior, not anonymous waitlist signup confirmation.
- Transactional email infrastructure is the durable path for outbound email confirmation when the recipient is not an account.
- Admin deployables remain thin composition roots; the Public Presence context owns the waitlist admin route and page.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-waitlist-admin-review`
- Branch: `codex/waitlist-admin-review`
- Base: current source repo `HEAD` (`8cc4f1e6 Add notifications database to staging platform (#72)`), per skill rule because no alternate base was requested.
- Source repo state at setup: `main...origin/main [behind 25]`, no local file changes reported.
- Dependency setup: `node ./scripts/worktree-deps.mjs install` completed successfully using shared pnpm store `D:\Users\ToddS\Source\Repos\.chase-sets-pnpm-store`.
- Sandbox id: `5f5fde9b`
- Sandbox doctor: passed.
- Sandbox ports:
  - Dev portal: `http://localhost:7550`
  - Admin web: `http://localhost:7552`
  - Marketplace: `http://localhost:7553`
  - Public web: `http://localhost:7554`
  - Platform API: `http://localhost:7562`
  - Platform worker: `http://localhost:7563`
- Setup blockers: none.

## Owning Contexts

### Public Presence

Owner for the core change.

Repo evidence:

- `bounded-contexts/README.md` says Public Presence owns public product pages, prelaunch policy surfaces, waitlist behavior, and internal waitlist review.
- `bounded-contexts/public-presence/context.json` declares owned noun `waitlist-signup`, slice `waitlist`, route contributions for public web home and admin web waitlist, and an admin primary-nav contribution labeled `Waitlist`.
- `bounded-contexts/public-presence/GLOSSARY.md` defines Waitlist Signup as an email-consented early-access request, not an Account, User, Buyer, or Seller.
- `bounded-contexts/public-presence/features/waitlist/domain/domain.ts` records and updates Waitlist Signup events.
- `bounded-contexts/public-presence/features/waitlist/read-model/*` owns the admin review projection and queries.
- `bounded-contexts/public-presence/features/waitlist/ui/admin-pages.tsx` already renders filters, metrics, rows, and CSV export.

Decision:

- Keep waitlist signup confirmation source facts and admin review in Public Presence.
- Add any waitlist confirmation email intent/projector under `bounded-contexts/public-presence/features/waitlist/integrations/transactional-email/`.
- Add any waitlist admin navigation or route discoverability fix through manifest/platform-runtime composition, not custom deployable pages.

### Notifications

Not the owner for this visitor confirmation unless the decision changes to a signed-in account Notification Center item.

Repo evidence:

- `bounded-contexts/notifications/README.md` says Notifications owns account notification delivery policy, notification settings, and notification-center feed.
- `bounded-contexts/notifications/GLOSSARY.md` defines Notification Center and Notification Feed Item as account-level concepts.
- Waitlist Signup is explicitly not an Account/User in Public Presence glossary.

Decision:

- Do not use the Notifications context's account notification center for anonymous waitlist confirmation.
- Use transactional email if "send a notification out" means an outbound confirmation to the submitted email address.

### Identity/Auth

Supporting contexts only.

Repo evidence:

- `bounded-contexts/identity/features/memberships/read-model/constants.ts` includes `public-presence.view` and `public-presence.manage` in platform admin/admin roles.
- `deployables/admin-web/app/routes/experience-layout.tsx` already allows actors with `platform-feedback.view` or `public-presence.view` into the Experience section layout.
- `deployables/admin-web/app/auth.server.ts` resolves admin actors through Identity/Auth host policy.

Decision:

- Do not introduce a new platform-admin concept.
- Use existing `public-presence.view` authorization for waitlist list, metrics, and export.

## Resolved Decisions

1. Canonical term: `Waitlist Signup`.
   - Evidence: Public Presence glossary.
   - Consequence: UI copy may say "waitlist" naturally, but code/docs should keep durable behavior under Waitlist Signup.

2. Admin review owner: Public Presence.
   - Evidence: context map and Public Presence manifest already declare internal waitlist review.
   - Consequence: no new Experience-owned waitlist dashboard and no deployable-owned waitlist table.

3. Admin dashboard likely exists but is not discoverable enough.
   - Evidence: Public Presence contributes `admin-web` route `waitlist`; platform runtime maps Public Presence admin routes into the `experience` section as `/experience/waitlist`. The admin root currently redirects to `/catalog/dimensions`.
   - Evidence: Public Presence contributes a `Waitlist` primary-nav item requiring `public-presence.view`; `ExperienceAdminLayout` requests nav items for `section: "experience"`.
   - Implementation should verify if the nav item appears for seeded platform admins and add tests around route/nav resolution so it cannot disappear silently.

4. Public landing page already shows an in-page success banner.
   - Evidence: `bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx` renders a success `Banner` when action data status is `joined`.
   - Consequence: "notification out" probably means outbound confirmation, not just UI success copy.

5. Durable outbound confirmation should use transactional email unless the product decision says otherwise.
   - Evidence: repo already has `contracts/communications-email`, `infrastructure/transactional-email-outbox`, and context-local transactional-email projectors in Auth, Ordering, Fulfillment, and Settlement.
   - Consequence: add Public Presence host port `transactionalEmailOutbox`, schema composition, projector subscription, and dispatcher participation through existing worker composition.

6. Waitlist confirmation channel: transactional email to the submitted email address.
   - User decision: `Email (Recommended)`.
   - Decision: send a transactional email on `public-presence.waitlist-signup.recorded`, and do not resend on duplicate `public-presence.waitlist-signup.updated` unless the submitted email changes in a future model.
   - Why: waitlist visitors are anonymous and may not have accounts, the form already renders an in-page success banner, and email consent is required to join the waitlist.
   - Consequence: do not create account Notification Center feed items for anonymous waitlist signups.

## Open Questions

None blocking.

## Implementation Checklist

1. Add route/nav discoverability tests for the admin waitlist dashboard.
   - Verify Public Presence admin route resolves as `/experience/waitlist`.
   - Verify actors with `public-presence.view` see the `Waitlist` nav item in Experience admin primary nav.
   - Verify platform admin role constants continue granting `public-presence.view`.

2. Fix admin dashboard discoverability if tests expose drift.
   - Preferred fix: manifest/platform-runtime composition.
   - Likely area: `infrastructure/platform-runtime/web.ts`, `deployables/admin-web/app/routes/experience-layout.tsx`, or Public Presence `context.json`.
   - Keep route owned by `bounded-contexts/public-presence/routes/admin/waitlist.tsx`.

3. Implement waitlist confirmation email if approved.
   - Add a Public Presence waitlist transactional email intent mapper.
   - Add a projector for `public-presence.waitlist-signup.recorded`.
   - Use idempotency key like `public-presence:waitlist-signup-confirmation:${signupId}`.
   - Use message type like `public-presence.waitlist-signup-confirmation`.
   - Include copy that says the visitor officially joined the Chase Sets waitlist and what happens next.
   - Do not enqueue for spam honeypot rejections, validation failures, or duplicate update events unless explicitly decided.

4. Wire the Public Presence transactional email outbox.
   - Add `@chase-sets/communications-email` and `@chase-sets/transactional-email-outbox` dependencies if needed.
   - Add transactional email outbox schema to `bounded-contexts/public-presence/support/runtime-support/schema.ts`.
   - Add a `transactionalEmailOutbox` host port to `bounded-contexts/public-presence/context.json`.
   - Ensure `platform-worker` and, if needed for admin-support runtime, `admin-support-worker` dispatchers can process Public Presence email outbox rows.
   - Add/update event subscription metadata for the email projector.

5. Preserve waitlist read model/admin review behavior.
   - Do not move waitlist admin UI into the deployable.
   - Keep API authorization on `public-presence.view`.
   - Ensure admin list, metrics, filters, and CSV export remain available.

6. Tests.
   - Public Presence waitlist domain/API existing tests.
   - New transactional email intent and projector tests.
   - Public Presence runtime/schema tests if available or add focused coverage.
   - Platform runtime/admin web route/nav tests.
   - Localization check if new copy is added.
   - Structure check after manifest/dependency changes.

7. Visual verification.
   - Public web waitlist success state on desktop and mobile.
   - Admin web `/experience/waitlist` on desktop and mobile.
   - Confirm no text overlap and all UI stays inside design-system components.

## Documentation To Promote

- Update `bounded-contexts/public-presence/GLOSSARY.md` only if a new durable term is introduced. Current terms likely suffice.
- Add `bounded-contexts/public-presence/docs/waitlist-confirmation.md` only if implementation requires a durable policy note for confirmation email behavior, duplicate handling, and admin review.
- Update `docs/GLOSSARY.md` only if the confirmation concept crosses contexts as a named term. Current plan avoids that by treating it as a Public Presence email intent, not a new cross-context noun.
- No ADR currently recommended. The design follows existing event-sourced transactional email patterns and is reversible.

## Implementation Notes

- Added Public Presence waitlist transactional email intent/projector code under `bounded-contexts/public-presence/features/waitlist/integrations/transactional-email/`.
- Wired Public Presence runtime/schema/context metadata to own a transactional email outbox host port and subscribe the waitlist email projector to `public-presence.waitlist-signup.recorded`.
- Confirmation email uses idempotency key `public-presence:waitlist-signup-confirmation:${signupId}`, subject `You officially joined the Chase Sets waitlist`, template id `waitlist_signup_confirmation`, and operational criticality.
- Duplicate waitlist update events do not resend the confirmation.
- Made the existing Public Presence waitlist dashboard easier for platform admins to find by linking the Experience section from Catalog and Identity admin section layouts.
- Added platform runtime coverage that the Public Presence waitlist admin route resolves to `/experience/waitlist` and that the nav contribution is available to actors with `public-presence.view`.
- Fixed worker runner scheduling fairness so later context runners, including the Public Presence transactional email dispatcher, are not starved when runner concurrency is lower than runner count.
- No durable glossary or ADR promotion was needed because no new cross-context noun was introduced.

## Verification

- `node ./scripts/worktree-deps.mjs install`
- `pnpm run sandbox:doctor`
- `pnpm install --lockfile-only`
- `CI=true pnpm run sync:workspace-metadata`
- `pnpm --filter @chase-sets/public-presence run test`
- `pnpm --filter @chase-sets/public-presence run typecheck`
- `pnpm --filter @chase-sets/platform-runtime run test`
- `pnpm --filter @chase-sets/platform-runtime run typecheck`
- `pnpm --filter @chase-sets/app-admin-web run typecheck`
- `pnpm --filter @chase-sets/app-admin-web run test`
- `pnpm run check:localization`
- `pnpm run check:structure`
- `pnpm run check:no-any`
- `pnpm run verify:metadata`
- `pnpm --filter @chase-sets/app-public-web run build`
- `pnpm --filter @chase-sets/app-admin-web run build`

Browser verification in the sandbox:

- Public landing page waitlist signup showed the in-page success banner after submission for `audit-1778864493448@example.com`.
- Public Presence `transactional_email_outbox` received the waitlist confirmation email row and the platform worker dispatched it to `sent`.
- The sent outbox row used message type `public-presence.waitlist-signup.recorded`, subject `You officially joined the Chase Sets waitlist`, template id `waitlist_signup_confirmation`, and idempotency key `public-presence:waitlist-signup-confirmation:wls_kn5vvf`.
- Admin web `/experience/waitlist` loaded for a platform admin and showed the submitted signup in the waitlist review table.
- Desktop screenshots were checked at `1280x720` for public waitlist success and admin waitlist review.
- Mobile screenshots were checked at `390x844` for public waitlist success, admin waitlist review metrics/filters/nav, and the mobile signup record layout. No incoherent text overlap was observed.

Remaining delivery work outside this local implementation:

- Commit the plan and implementation changes.
- Submit a PR.
- Ensure CI passes.
- Merge after approval.
- Verify the deployed change in staging.

## Goal Completion Criteria

The implementation goal should complete all of the following:

- Implement the approved waitlist confirmation notification behavior in the feature worktree.
- Ensure platform admins can discover and review waitlist signups from admin web.
- Keep behavior under Public Presence and use existing transactional email infrastructure if outbound email is approved.
- Retain this plan at `.codex/plans/20260515-waitlist-admin-review.md`.
- Promote any durable context documentation needed by the final design.
- Run focused automated tests, typechecks, localization checks if copy changes, and structure checks.
- Run desktop and mobile visual checks for public waitlist success and admin waitlist review.
- Commit the plan and implementation changes.
- Submit a PR.
- Ensure CI passes.
- Merge the PR when approved.
- Verify the change in staging after deploy, including public signup confirmation behavior and admin waitlist visibility.
