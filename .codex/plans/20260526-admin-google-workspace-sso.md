# Admin Google Workspace SSO

## Intent

Add Google Workspace SSO for admin platform sign-in so internal users can enter admin surfaces through Google OAuth using their existing browser Google session, while server-side Auth enforces a configured Workspace hosted-domain allowlist before starting a Chase Sets session.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-admin-google-workspace-sso`
- Branch: `codex/admin-google-workspace-sso`
- Sandbox id: `bfaa8d16`
- Dependency setup status: complete via `pnpm run deps:install`; `pnpm run sandbox:doctor` passed
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Auth owns the admin authentication journey, browser session lifecycle, Social Login provider redirect state, callback verification, account selection, and `/api/auth` route surface.
- Identity remains upstream for users, memberships, permissions, and durable Social Login Link facts.
- Platform API remains a thin composition root that loads provider configuration and passes Auth host ports.

Repo evidence:

- `bounded-contexts/auth/README.md` says Auth owns sign-in flows, browser session cookie conventions, session lifecycle, actor resolution helpers, and `/api/auth`.
- `bounded-contexts/auth/context.json` already declares `social-login-support` for Google and Facebook provider behavior shared by sign-in, registration, and deployable composition.
- `bounded-contexts/identity/README.md` says Identity owns users, memberships, roles, permissions, and durable identity facts, but does not own sign-in or browser session-token persistence.
- `docs/architecture/bounded-context-structure.md` says deployables remain thin roots and bounded contexts own real route modules.

## Resolved Decisions

- Use the existing Auth Social Login OAuth flow instead of adding SAML. The repo already has provider-neutral Social Login, Google OAuth configuration, state persistence, callback handling, and session start behavior.
- Add an admin-only Social Login journey rather than reusing marketplace registration behavior. Admin SSO must not create a new personal marketplace identity when a Google Workspace profile is unknown.
- Keep allowed Workspace domains configurable through platform API environment, not hard-coded. The user asked for Chase Sets domains, and future internal domains should be an operations change.
- Enforce the hosted-domain allowlist server-side in Auth before link/session creation. Google OIDC docs warn `hd` on the request is only UI optimization; the returned token claim must be checked for access control.
- Use Google OAuth redirect as the practical browser-profile experience. Google Identity Services automatic sign-in can be zero-click only after prior consent and browser/FedCM conditions, so the server redirect can reuse the current Chrome Google session but cannot read the Chrome profile directly.

## Open Questions

- None blocking. The initial allowed domain values will be supplied by deployment configuration.

## Implementation Checklist

- [x] Install worktree dependencies and run sandbox doctor.
- [x] Extend Social Login provider profiles with optional hosted domain.
- [x] Add Google `hd` request hint and server-side hosted-domain profile support.
- [x] Add admin Social Login journey/state handling that rejects unconfigured or non-Workspace Google profiles and unknown users.
- [x] Add admin sign-in UI/route entry points for Google Workspace SSO without affecting marketplace registration.
- [x] Load admin Workspace SSO configuration in platform API and pass it to Auth services.
- [x] Update environment examples, Terraform app env wiring, GitHub workflow pass-through, runbook, and localization.
- [x] Add focused tests for provider domain hints, admin SSO domain enforcement, and no auto-provisioning.
- [x] Run targeted checks, then broader verification as practical.

## Verification

- `pnpm --filter @chase-sets/auth test -- --run support/api-support/social-login-routes.test.ts support/social-login-support/providers.test.ts features/sign-in/ui/sign-in-page.test.tsx`
- `pnpm --filter @chase-sets/app-platform-api test -- --run __tests__/config.test.ts`
- `pnpm run check:no-any`
- `pnpm exec tsc -p ./tsconfig.json --noEmit`
- `pnpm run verify:static`
- `pnpm run verify:test`
- `pnpm run verify:test-db`
- `pnpm run verify:build`
- `node ./scripts/run-workspaces.mjs typecheck --concurrency=4`
- After workflow pass-through and guard cleanup: `pnpm run verify:static`, `pnpm --filter @chase-sets/auth test -- --run support/api-support/social-login-routes.test.ts`, `pnpm run format:check`

## Documentation To Promote

- Update `docs/runbooks/social-login-operations.md` with admin Google Workspace SSO configuration and redirect URI expectations.
- Keep this plan committed with the implementation.

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
