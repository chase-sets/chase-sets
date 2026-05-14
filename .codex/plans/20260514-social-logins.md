# Social Logins

## Intent

Users should be able to quickly register or sign in to Chase Sets with accounts they already have, starting with Google and Facebook.

Planning uses the bounded-context workflow. This plan is the durable implementation guide; product code, runtime code, schemas, tests, and UI are intentionally unchanged during planning.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260514-social-logins`
- Branch: `codex/social-logins`
- Base: current source repo HEAD `8cc4f1e6cff8c07820fe00bd88651e74d74fa83d`
- Sandbox id: `8a1c1332`
- Dependency setup: `pnpm run deps:install` succeeded on 2026-05-14.
- Sandbox doctor: `pnpm run sandbox:doctor` succeeded on 2026-05-14.
- Setup caveats: source repo `main` was 8 commits behind `origin/main` when this worktree was created; the workflow says to branch from current repo HEAD unless the user names a base.

## Owning Contexts

- Auth is the primary behavior owner for social login journeys because Auth owns sign-in, registration, session lifecycle, session cookies, account-selection continuation, and the mounted `/api/auth` surface.
- Identity owns user, account, membership, contact method, consent, and user-level authentication method facts. Auth should continue using Identity internal auth-facing endpoints only for Identity-owned mutations.
- Infrastructure should own provider adapters and provider secret loading, while provider-specific behavior should be composed into Auth through a small provider-neutral port.
- Deployables remain thin composition roots for environment wiring and route mounting only.

Repo evidence:

- `bounded-contexts/README.md` says Auth owns sign-in, sign-out, registration, session lifecycle, and session-entry journeys; Identity owns users, accounts, memberships, invitations, API keys, consents, and identity-management surfaces.
- `bounded-contexts/auth/README.md` says Auth owns authentication journeys, browser session lifecycle, session-cookie and return-path behavior, and `/api/auth`.
- `bounded-contexts/identity/README.md` says Identity does not own sign-in, registration, sign-out, credential verification flows, session aggregates, or browser session-token persistence.
- `bounded-contexts/identity/GLOSSARY.md` defines Authentication Method as a configured way a user can sign in, and gives Google login as an example while saying Auth owns the journey using those methods.
- `bounded-contexts/auth/features/sessions/domain/auth-flow.ts` currently defines `AuthMethod` as `password | magic-link | passkey`.
- `bounded-contexts/identity/support/runtime-support/common.ts` currently defines `AuthMethodKey` as `password | magic-link | passkey`.
- `bounded-contexts/auth/api.ts` wires current auth API route groups for registration, password, magic link, guest checkout, account selection, passkeys, invitations, and sessions.
- `bounded-contexts/auth/support/runtime-support/schema.ts` currently stores Auth-owned credential/challenge/session tables in Auth setup, including password credentials, passkey credentials, magic link tokens, auth challenges, session tokens, account-selection tokens, and guest checkout tokens.
- `bounded-contexts/identity/api.ts` exposes internal auth-facing endpoints for personal identity creation and for enabling password/passkey credentials.
- Current sign-in and registration UI copy presents password, magic link, and passkey only.

## Resolved Decisions

- Canonical feature term: **Social Login** for the user-facing capability.
- Canonical provider term: **Social Login Provider** for Google and Facebook as configured external identity providers.
- Existing verified-email behavior: when Google or Facebook returns a verified email that matches an existing Chase Sets user, link the provider to that existing user, start a session, and preserve account-selection behavior for users with multiple accounts.
- Identity should own a first-class user social login link fact so Auth can record that a provider identity is now an authentication method for the user without storing provider tokens or provider-specific identity state in the session event payload.
- Canonical method language: use provider-neutral `social-login` as the Identity authentication method, with provider-specific link facts for `google` and `facebook`. Auth session/read models may expose a provider-specific session method label such as `google` or `facebook` for operator clarity, but the durable user capability remains provider-neutral plus linked provider facts.
- Start with marketplace register and sign-in surfaces. Admin sign-in may get configuration support later, but should not be the first user-visible surface unless explicitly required.
- First-time social registration should require only provider-verified email plus display name before creating the personal Identity user/account/membership. Given/family names may be stored when provided but must not block the journey. Additional profile/account enrichment stays in Identity-owned account settings.
- Providers that do not return a verified email must not create or link a Chase Sets user. Auth should return the user to the same journey with existing fallback methods such as magic link, passkey, or password.

## Open Questions

No open product/domain questions remain for the first implementation pass.

Settled security constraint: automatic linking depends on verified email ownership. If the provider cannot confirm the email, Chase Sets must not treat that provider profile as proof that the user owns an existing marketplace user or should receive a new account.

## Implementation Checklist

- Add provider-neutral Auth port for social login authorization URL creation, callback verification, profile normalization, and provider state validation.
- Add Google and Facebook provider adapters in infrastructure or an Auth-owned provider module with secrets supplied by deployable config.
- Add Auth-owned state/nonce storage for social login attempts, including return path and intended journey (`sign-in` or `registration`).
- Add Auth API endpoints under `/api/auth/social/:provider/start` and `/api/auth/social/:provider/callback`, or an equivalent route shape settled during implementation.
- Add Identity user-provider link behavior: command, event, projection fields, internal auth endpoint, and Auth identity projection subscription update.
- Ensure provider profile handling requires verified email for link/create behavior and returns fallback UI state when provider email is missing or unverified.
- Extend Auth session method language to include accepted social methods without making external provider tokens part of the session event payload.
- Extend marketplace sign-in and registration UI with design-system controls for Google and Facebook, using provider icons only from the design system or an approved icon source.
- Preserve safe return-path handling and account-selection continuation for users with multiple memberships.
- Add localization keys for new UI and API messages.
- Add tests for callback success, duplicate provider link conflict, existing-email behavior, new-user registration, account-selection continuation, stale/invalid state, provider failure, and suspended user denial.
- Add config validation and runbook notes for provider app setup, callback URLs, secret rotation, and staging smoke checks.

## Documentation To Promote

- Add Auth glossary entries for Social Login and Social Login Provider.
- Add Identity glossary detail only if user-provider links become Identity-owned facts.
- Add or update an Auth context doc for social login journey policy and provider-neutral adapter boundaries.
- Add runbook documentation for Google/Facebook OAuth app setup, callback URLs, secret management, local/staging provider modes, and smoke testing.
- Update `docs/README.md` if a durable Auth doc or runbook is added.
- Consider an ADR only if the plan chooses automatic existing-user linking without prior password/passkey proof, because that decision is security-sensitive and hard to reverse after launch.

## Implementation Status

Completed locally on 2026-05-14:

- Added Google and Facebook Social Login provider ports/adapters, Auth start/callback routes, one-use hashed callback state, safe return paths, same-journey fallbacks, provider failure handling, duplicate-link fallback behavior, and account-selection continuation.
- Added Identity-owned Social Login Link behavior with command/event/projection state, lookup table, replay-safe projection updates, and internal Auth-facing link endpoint.
- Wired Platform API configuration and provider composition through deployable config while keeping deployables as composition roots.
- Added marketplace sign-in and registration Social Login controls with localized fallback error display.
- Added Auth/Identity glossary terms, Auth journey policy documentation, operations runbook, docs index entries, and this plan artifact.
- Added unit and route coverage for provider mapping, callback success, existing-email linking, new-user registration, account-selection continuation, invalid/unverified provider email fallback, provider failure, duplicate provider link fallback, config loading, and Identity domain behavior.
- Completed desktop and mobile visual checks for marketplace sign-in and registration in the local browser against the dev stack.

Verified locally:

- `pnpm --filter @chase-sets/auth test`
- `pnpm --filter @chase-sets/identity test`
- `pnpm --filter @chase-sets/app-platform-api test`
- `pnpm run check:localization`
- `pnpm run check:structure`
- `pnpm run check:no-any`
- `pnpm run verify:typecheck`
- `pnpm run verify:static`
- `pnpm run verify:test-db`
- `pnpm run verify:test`
- `pnpm run verify:build`

Remaining outside this local implementation pass:

- Submit a PR from `codex/social-logins`.
- Get CI passing.
- Merge the PR.
- Verify staging with Google and Facebook configured in non-production/test mode or documented safe provider test credentials.

## Goal Completion Criteria

The later implementation goal must:

- Implement the accepted social login behavior in this worktree and branch.
- Keep behavior in owning bounded contexts and deployables as thin composition roots.
- Promote durable docs listed above and retain this plan.
- Verify automated tests for Auth, Identity, API composition, localization, and relevant deployables.
- Run mobile and desktop visual checks for marketplace sign-in and registration.
- Submit a PR from `codex/social-logins`.
- Get CI passing.
- Merge the PR.
- Verify the staging deploy with Google and Facebook configured in non-production/test mode or documented safe provider test credentials.
