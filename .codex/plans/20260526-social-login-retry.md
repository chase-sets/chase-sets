# Social Login Retry Failure

## Intent

Fix the staging admin Google Workspace SSO retry path where a user can sign in once, sign out, and then gets redirected back to catalog sign-in with `Social login provider could not be reached`.

## Working Context

- Worktree: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-social-login-retry`
- Branch: `codex/social-login-retry`
- Base: `origin/main` at `0ab4fb8e`
- Owning bounded context: Auth
- Related bounded context: Identity owns durable user social login links
- Deployable touched only as composition root if needed: platform API

## Evidence

- Staging `catalog-admin` social start redirects to Google with the expected HTTPS callback:
  `https://admin.staging.chasesets.com/api/auth/social/google/callback`.
- The user-visible error maps to Auth social callback fallback text.
- Staging platform logs show the first callback completed Identity social login linking with 200.
- Subsequent callbacks reached Google callback handling, then Identity `POST /api/identity/internal/auth/users/usr_platform_admin/social-login-link` returned 400 before Auth redirected.
- This points at repeat sign-in/link idempotency, not a missing provider config or an unreachable Google authorization URL.

## Delivery Checklist

- [x] Isolate work in a fresh worktree from `origin/main`.
- [x] Read Auth bounded-context docs and glossary.
- [x] Reproduce/inspect live staging path and logs.
- [x] Inspect Auth-to-Identity link semantics and tests.
- [x] Implement the smallest Auth/Identity-owned fix for repeated admin SSO.
- [x] Add focused tests for sign-in after an existing social login link.
- [x] Run affected tests.
- [ ] Open PR, verify CI, merge.
- [ ] Verify staging deployment and live admin SSO endpoints.
- [ ] Clean local worktree after deployment verification.

## Current Hypothesis

Admin SSO callback links the Google profile to the platform admin user on every successful callback. The first login creates the link. Later logins with the same Google profile hit Identity duplicate-link validation and Auth maps the failure to the generic provider failure message. The retry path should be idempotent when the existing social login link already belongs to the same admin user.

## Implemented Fix

Identity user aggregate commands now treat duplicate `EnableAuthMethod` and same-user `LinkSocialLogin` commands as successful no-ops. The Identity internal Auth route already rejects links owned by another user before issuing the command, so this keeps cross-user conflict behavior while making same-user replay/retry safe when read models lag the aggregate stream.

## Local Verification

- `pnpm --filter @chase-sets/identity run test -- features/users/domain/domain.test.ts tests/internal-auth-routes.test.ts`
- `pnpm --filter @chase-sets/auth run test -- support/api-support/social-login-routes.test.ts`
- `pnpm exec prettier --check bounded-contexts/identity/features/users/domain/domain.ts bounded-contexts/identity/features/users/domain/domain.test.ts .codex/plans/20260526-social-login-retry.md`
- `pnpm run check:no-any`
- `pnpm exec tsc -p ./tsconfig.json --noEmit --pretty false`

`pnpm run typecheck` was attempted twice locally and timed out before returning a result; the split `check:no-any` and root `tsc` checks passed, and full typecheck coverage will be verified in CI.
