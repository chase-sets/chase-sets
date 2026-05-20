# Source Observation Refresh

## Intent

Implement a Catalog-owned refresh path for provider Source Observations and for applying refreshed observations to existing Catalog Items.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-source-observation-refresh`
- Branch: `codex/source-observation-refresh`
- Sandbox id: `bee945ff`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Catalog owns Source Observations, Catalog Items, provider keys, source hashes, review status, and promotion into Catalog Item commands.
- No cross-context behavior is needed for this change.

## Resolved Decisions

- Re-importing TCGdex remains the source refresh trigger. The import command should continue to be idempotent for unchanged observed records.
- Changed observations that have already been promoted should move into a reviewable `changed` status instead of silently mutating the Catalog Item.
- Promoting an observed Source Observation still creates a new draft Catalog Item.
- Promoting a changed Source Observation with an existing promoted Catalog Item applies the normalized provider facts to that existing Catalog Item and returns the observation to `promoted`.
- Rejected observations remain terminal for now. They can be intentionally imported into a future new-observation workflow if needed, but this change focuses on the promoted-item refresh path.
- The Catalog Item keeps its `catalog_item_id`; descriptive fields, metadata, tags, images, source assets, and source reference are refreshed through normal Catalog Item commands.

## Implementation Checklist

- [x] Update Source Observation domain status and transition rules.
- [x] Update source-observation projection and queries for `changed` review eligibility.
- [x] Reuse promotion mapping logic so initial promotion and refresh apply the same Catalog facts.
- [x] Add Source Observation runtime behavior that updates existing Catalog Items when a changed observation is promoted.
- [x] Update API/UI contracts and docs to make the refresh path visible and durable.
- [x] Add focused domain/read-model/runtime/route tests.
- [x] Run targeted Catalog tests and repo checks.

## Documentation To Promote

- `bounded-contexts/catalog/docs/source-observation-integration.md`

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
