# Admin Support SSO Composition

## Intent

Make production admin Google Workspace SSO use the same Auth social-login composition that staging already uses. Production routes admin `/api` traffic to `admin-support-api`, so that deployable must allow anonymous social-login start/callback routes and provide the Google SSO host ports to Auth.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-admin-support-sso`
- Branch: `codex/admin-support-sso`
- Sandbox id: not created
- Dependency setup status: complete; `pnpm run deps:install` completed before verification
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Auth owns social login journeys and Google Workspace hosted-domain enforcement.
- Admin Support API owns the production admin API composition root and must pass Auth host ports without moving behavior out of Auth.
- DigitalOcean Platform owns environment wiring for the production admin API component.

## Resolved Decisions

- Keep Auth behavior unchanged.
- Mirror only the provider/config composition needed by `admin-support-api`.
- Keep production routing to `admin-support-api`; do not route production admin traffic to the broader `platform-api`.

## Open Questions

- None.

## Implementation Checklist

- [x] Load Google social-login and admin Workspace SSO config in `admin-support-api`.
- [x] Pass Google social-login provider and admin Workspace SSO policy into Auth host ports from `admin-support-api`.
- [x] Allow anonymous `GET /api/auth/social/*` through `admin-support-api` identity middleware.
- [x] Wire Google SSO environment values into the production admin-support-api component.
- [x] Run focused config, app, Auth route, structure, and static verification.
- [ ] Open PR, wait for CI, merge, deploy, and verify production admin SSO starts.

## Documentation To Promote

- No durable docs expected; this is production deployable composition for the already-documented SSO configuration variables.

## Goal Completion Criteria

- PR submitted for the completed implementation.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after rollout.
- Live staging and production admin SSO provider/start endpoints verified.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
