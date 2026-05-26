# Auth Social Provider Host Port

## Intent

Make configured Social Login Providers available to the Auth bounded context at runtime. Google OAuth credentials are now present in GitHub environments and DigitalOcean App Platform, but Auth receives an empty provider list because the context manifest does not declare the `socialLoginProviders` host port.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-auth-social-provider-port`
- Branch: `codex/auth-social-provider-port`
- Sandbox id: not created
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Auth owns Social Login journeys, provider redirect state, callbacks, and session creation.
- Platform API composes provider adapters from environment configuration and supplies them through a host port.

## Resolved Decisions

- Declare `socialLoginProviders` in Auth `context.json` so platform runtime composition passes the already-built provider adapters into `createAuthServices`.
- Keep provider credentials and raw provider payloads out of Auth events; only the adapter list crosses the host composition boundary.
- No route or UI behavior change is needed; the existing `/api/auth/social/*` routes already handle configured providers once the host port is available.

## Open Questions

- None.

## Implementation Checklist

- [x] Add `socialLoginProviders` to Auth host ports.
- [x] Run focused structure/config verification.
- [ ] Open PR, wait for CI, merge, deploy, and verify Google provider is advertised in staging and production. PR #315 opened.

## Documentation To Promote

- No durable docs are needed; the existing Auth glossary already defines Social Login Provider boundaries.

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
