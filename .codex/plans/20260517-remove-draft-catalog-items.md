# Remove Draft Catalog Items

## Intent

Incorrect draft Catalog Items can currently be created but cannot leave the draft status unless they become publishable. Add a Catalog-owned way to remove draft-only mistakes from the admin Catalog Items grid while preserving event-sourced audit history.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-remove-draft-catalog-items`
- Branch: `codex/remove-draft-catalog-items`
- Sandbox id: `c2967eb9`
- Dependency setup status: `pnpm run deps:install` completed.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox doctor: passed; admin web `http://localhost:8452`.
- Setup blockers: none.

## Owning Contexts

- Catalog owns Catalog Item identity, state transitions, read models, API routes, UI, and tests.
- No cross-context behavior is needed because draft Catalog Items have not published Catalog truth downstream.

## Resolved Decisions

- Ownership: implement entirely inside `bounded-contexts/catalog/features/catalog-items` plus Catalog shell API client support.
- Language: use `Catalog Item` formally; admin UI may use `Item` where already established. The command name should be explicit: `RemoveDraftCatalogItem`.
- Invariant: only draft Catalog Items may be removed. Active items must still retire before archive; retired items must still archive through the existing lifecycle.
- Event: record a Catalog-internal event such as `catalog.catalog-item.draft-removed`. This preserves event-store audit without creating downstream integration events.
- Read models: on replay, delete the draft from `catalog_items`; existing foreign keys cascade to admin list/detail pages and external product references.
- API: expose a focused admin command endpoint under Catalog Items, likely `DELETE /api/catalog/items/:id`, mapped to `RemoveDraftCatalogItem`.
- UI: add a danger action for selected draft rows in the Catalog Items grid. After success, clear selection and revalidate the list.
- Tests: cover domain allow/reject rules, route command mapping, read-model deletion, and the list UI action.

## Stress Test

- Normal flow: an admin selects one or more draft rows and removes them; the rows disappear after revalidation.
- Partial flow: if a selected row is no longer draft, the command fails for that row and the UI reports the error through existing toast behavior.
- Stale data or replay: the event store remains the audit source; projections delete read rows when `draft-removed` replays.
- Cross-context handoff: none; no Catalog integration event is emitted because drafts are not downstream product truth.
- Failure/cancellation: command failures leave the draft rows unchanged; UI selection remains until success.
- Low-value card economics: removing bad import/promote drafts reduces catalog cleanup friction and avoids forcing incorrect low-value products into publish/archive workflows.

## Open Questions

- None. The repository evidence supports a draft-only removal command rather than widening archive semantics.

## Implementation Checklist

- Completed: add domain command/event/evolver support for draft removal.
- Completed: add projection and admin projection handlers that remove deleted drafts from Catalog Item read models.
- Completed: add API client and route support.
- Completed: add list-grid bulk action for selected draft rows.
- Completed: add focused tests for the domain, API route, projection, and UI.
- Completed: run Catalog tests and relevant type/static checks.

## Verification

- Rebased onto `origin/main` at `a3d9453b`.
- `pnpm --filter @chase-sets/catalog test` passed after rebase: 21 files passed, 1 skipped; 155 tests passed, 4 skipped.
- `pnpm run verify:typecheck` passed after rebase.
- `pnpm run check:localization` passed after rebase.
- `pnpm run check:structure` passed after rebase.
- Browser smoke was attempted before rebase, but `pnpm run dev:admin-web` did not finish sandbox platform API bootstrap; the sandbox was stopped with `pnpm run dev:down`.

## Documentation To Promote

- No durable architecture doc is needed unless implementation reveals a broader lifecycle policy that affects other Catalog authoring concepts.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
