# Catalog Realtime Reload Prompt

## Intent

Reduce repeated Catalog admin list loader fetches during high-volume realtime activity, especially Source Observation bulk promotion into draft Catalog Items.

## Worktree

- Path: `D:/Users/ToddS/Source/Repos/chase-sets/.codex/worktrees/20260522-catalog-reload-prompt`
- Branch: `codex/catalog-reload-prompt`
- Sandbox id: `6eadbce9`
- Dependency setup: `pnpm run deps:install` completed
- pnpm store: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Catalog owns the admin Source Observation promotion workflow, Catalog Item read models, realtime admin topics, route subscriptions, and admin list UI behavior.
- Deployables stay thin route composition roots.

## Resolved Decisions

- Keep existing automatic realtime revalidation as the default for low-volume admin pages.
- Add a reusable manual reload prompt mode for Catalog admin list pages with high-volume projected changes.
- Count unique projected entity ids from realtime patches and expose a reload action instead of automatically revalidating the route.
- Preserve `sync.required` as a reload prompt even when the exact changed count is unknown.
- Adopt the manual prompt on Catalog Items and Source Observations because Source Observation review jobs emit many patches on both admin list surfaces.

## Implementation Checklist

- Extend Catalog shell-support realtime hook with manual mode and pending-change state.
- Add a reusable Catalog admin realtime reload action bar component.
- Let `EntityListPage` show the reload action bar through the existing single `BulkActionSurface` slot.
- Adopt manual reload prompt on the Catalog Items and Source Observations routes.
- Add focused tests for patch counting, manual reload, and Catalog Items/Source Observations action-bar behavior.

## Documentation To Promote

- Update Catalog admin bulk workflow docs to make manual reload prompts the standard for high-volume list invalidations.

## Goal Completion Criteria

- Focused tests pass for the reusable realtime prompt and Catalog Items/Source Observations adoption.
- `pnpm` type/test verification relevant to the edited Catalog surfaces passes.
