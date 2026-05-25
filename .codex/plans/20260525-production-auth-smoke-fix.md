# Production Auth Smoke Fix

## Intent

Production deployment for the projection runtime overhaul applied successfully, but production smoke failed after admin password sign-in. The admin token was issued, then the admin waitlist API returned `401 Unauthorized`. Staging smoke passed.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260525-production-auth-smoke-fix`
- Branch: `codex/production-auth-smoke-fix`
- Sandbox id: `36ab285e`
- Dependency setup: `node ./scripts/worktree-deps.mjs install` completed.
- pnpm store: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none.

## Owning Contexts

- Auth owns session resolution and the auth-owned Identity membership projections needed to resolve an actor.
- Platform API remains a thin composition root and should delegate actor resolution to Auth.

## Resolved Decisions

- Keep the fix in Auth because the failed behavior is auth session actor resolution.
- Use `auth_identity_user_memberships` as the primary account-membership lookup for request-time actor resolution because sign-in already trusts the same mirror when creating sessions.
- Keep a compatibility fallback to `auth_identity_memberships` so deployments with older or partially rebuilt user-membership rows continue to authorize correctly.
- Add indexes for active user/account membership lookups because this path is used on authenticated requests.

## Implementation Checklist

- [x] Reproduce the code-path mismatch between sign-in membership reads and bearer-token actor resolution.
- [x] Resolve active account membership from the same user-membership mirror used by sign-in.
- [x] Preserve fallback compatibility with the existing membership mirror.
- [x] Add request-path indexes to the auth identity projection schema.
- [x] Run focused Auth tests.
- [x] Run typecheck/static verification.
- [ ] Submit PR, verify CI, merge, verify staging and production deploys.
- [ ] Clean hotfix and original overhaul worktrees/branches after production is green.

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
