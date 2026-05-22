# Account Entity Actions

## Intent

Accounts, Users, Memberships, Invitations, Sessions, and API Keys must expose common maintenance actions from admin surfaces and the appropriate self-service account surfaces. Tables should use meaningful display names instead of raw IDs where the underlying read models have enough data, and detail pages should preserve IDs only where operationally useful.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260522-account-entity-actions`
- Branch: `codex/account-entity-actions`
- Sandbox id: `b62b0d76`
- Dependency setup status: complete via `pnpm run deps:install`; `pnpm run sandbox:doctor` passed
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Identity owns Account, User, Membership, Invitation, and API Key behavior, read models, UI contracts, and routes.
- Auth owns Session lifecycle behavior, read models, UI contracts, and routes.
- Admin web and marketplace web remain thin composition roots through context manifests.

## Resolved Decisions

- Keep entity behavior in the owning feature slices: Identity feature UI/routes/API client for Account/User/Membership/Invitation/API Key; Auth session UI/routes/API client for Session.
- Use existing event-sourced commands already exposed by APIs before introducing new commands: account update/suspend/reactivate/close/badge assignment, user update/suspend/reactivate, membership role change/revoke/reinstate, invitation resend/cancel/decline, API key revoke, session account switch/revoke.
- Add missing API-client methods and route actions where the command endpoints already exist.
- Treat table ID replacement as a read-model/UI concern. Prefer account display name/legal name and user display name/email. Retain ID values in detail pages as secondary operational fields only.
- For self-service, expose actions that match the actor's own account boundary: update account profile, manage current user's profile/security, manage memberships/invitations/API keys for the current account/user, and revoke the current user's own sessions when session data is available.

## Open Questions

- None blocking after repo discovery. Existing permissions and domain commands define the first implementation boundary.

## Implementation Checklist

- [x] Install worktree dependencies and run sandbox doctor.
- [x] Expand Identity/Auth API clients with missing command methods.
- [x] Add route actions for admin detail pages.
- [x] Add route actions for marketplace account/team/security self-service pages.
- [x] Enrich membership, invitation, API key, and session read models/UI contracts with display labels where source data exists.
- [x] Replace table ID columns with meaningful names/labels.
- [x] Add focused tests for action wiring and display-label regressions.
- [x] Run targeted tests, typecheck/build checks as feasible.

## Documentation To Promote

- None expected unless implementation uncovers a boundary contradiction.

## Verification

- `pnpm run sandbox:doctor`
- `pnpm --filter @chase-sets/identity test`
- `pnpm --filter @chase-sets/auth test`
- `pnpm --filter @chase-sets/app-marketplace-web test`
- `pnpm run verify:typecheck`
- `pnpm run check:localization`
- `pnpm run check:structure`
- `pnpm run verify:metadata`
- `pnpm run format:check`
- Authenticated Playwright smoke against local dev stack:
  - Admin `identity/accounts`, `identity/memberships`, `identity/invitations`, `identity/api-keys`, and `identity/sessions`
  - Marketplace `account/team`, `account/security`, and `account/sessions`

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
