# Projection Backlog Indicators

## Intent

Show operators how many events remain to be drained by each projection consumer on the Projection Operations page.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260525-projection-backlog-indicators`
- Branch: `codex/projection-backlog-indicators`
- Sandbox id: `dc148438`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: default embedded worktree store
- Setup blockers: none; `pnpm run sandbox:doctor` passed.

## Owning Contexts

- `infrastructure/bounded-context-runtime`: canonical projection status calculation.
- `infrastructure/platform-runtime`: projection operations API returns runtime status unchanged.
- `deployables/admin-web`: admin operations UI rendering.

## Resolved Decisions

- Use `sourceHeadGlobalPosition - lastGlobalPosition` as the projection backlog. This is the number of source-context events still waiting to be inspected/drained by the consumer, which is the operational signal operators need.
- Represent backlog counts as decimal strings in the API to avoid losing precision if global positions exceed JavaScript safe integers.
- Surface backlog at three levels: summary total, projection group total, and subscription row detail.
- Bound projection-operations blocked-detail fanout to four concurrent projector detail queries. Local verification exposed an existing `too many clients already` failure with 110 runners when the status endpoint queried every projection key in parallel.

## Implementation Checklist

- Add `outstandingEventCount` to subscription, projection group, context summary, and global projection replay status.
- Update projection status refresh/run/reset paths to keep the derived backlog current.
- Update Projection Operations UI to show total outstanding events and per-subscription backlog.
- Add focused runtime tests for backlog calculation.
- Limit projection operations blocked-detail fanout so the status endpoint remains usable with many projectors.
- Update runbook language for the new operational signal.

## Goal Completion Criteria

- PR submitted for the completed implementation.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
