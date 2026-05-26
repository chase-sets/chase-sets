# Social Login Public Origin

## Intent

Generate Social Login OAuth callback URLs from the browser-facing origin instead of the internal request scheme. The live staging app now advertises Google, but the Google authorization redirect uses an `http://admin.staging...` callback behind the proxy, which will not match the HTTPS callback registered in Google Cloud.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-social-login-public-origin`
- Branch: `codex/social-login-public-origin`
- Sandbox id: not created
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Auth owns Social Login provider redirect state, callback verification, and safe return paths.

## Resolved Decisions

- Build Social Login callback origins from forwarded host/proto headers when present.
- Preserve local HTTP behavior for localhost-style development origins.
- Fall back to HTTPS for non-local hosts when the internal request URL reports HTTP.

## Open Questions

- None.

## Implementation Checklist

- [x] Update Social Login callback origin calculation.
- [x] Add route tests for forwarded HTTPS origin and local HTTP fallback.
- [ ] Open PR, wait for CI, merge, deploy, and verify Google redirects use HTTPS in staging and production. Local verification passed; PR #316 opened.

## Documentation To Promote

- No durable docs needed; this is a runtime proxy-origin correction.

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
