# Auth Admin SSO Host Port

## Intent

Pass the configured admin Google Workspace SSO policy into Auth. The live app now has the Google provider, but admin sign-in still reports that Workspace SSO is not configured because `adminGoogleWorkspaceSso` is not declared as an Auth host port.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-auth-admin-sso-port`
- Branch: `codex/auth-admin-sso-port`
- Sandbox id: not created
- Dependency setup status: complete; `pnpm run deps:install` completed before verification
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Auth owns admin Social Login journey enforcement.
- Platform API composes admin Workspace SSO policy from environment configuration and supplies it as a host port.

## Resolved Decisions

- Declare `adminGoogleWorkspaceSso` in Auth `context.json`.
- Keep the policy provider-neutral inside Auth; Auth only receives allowed hosted domains and enforces them during admin SSO.

## Open Questions

- None.

## Implementation Checklist

- [x] Add `adminGoogleWorkspaceSso` to Auth host ports.
- [x] Run manifest and Auth-focused verification.
- [ ] Open PR, wait for CI, merge, deploy, and verify admin Google Workspace SSO starts.

## Documentation To Promote

- No durable docs needed; the existing social login runbook already documents `ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS`.

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
