# Combine Catalog Item Retire And Archive

## Intent

Catalog Items currently expose both `Retire` and `Archive` lifecycle actions in the admin bulk action menu. The actions look similar to operators and the repo does not document a business policy that needs both terms for Catalog Items.

The implementation will combine them into one terminal `Archive` action for Catalog Items. Archive removes an active Catalog Item from future sellable use and makes it immutable. Existing historical retired events can still replay as archived so old streams do not strand read models during replay.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-combine-catalog-retire-archive`
- Branch: `codex/combine-catalog-retire-archive`
- Sandbox id: `f3797330`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Catalog owns Catalog Item lifecycle, read models, admin UI, API routes, and integration event publication.
- Discovery, Checkout, Inventory, and Pricing consume Catalog Item lifecycle facts through published Catalog events and local projections.

## Resolved Decisions

- Ownership: Catalog is the behavior owner because `Catalog Item` is a Catalog-owned noun in `bounded-contexts/catalog/context.json`.
- Language: keep `Archive` as the single user-facing action because archive is already the terminal lifecycle term across Catalog authoring slices.
- Invariant: archived Catalog Items are immutable and unavailable to downstream sellable flows.
- Events: stop emitting new `catalog.catalog-item.retired` and `CatalogItemRetired` events for Catalog Items; retain replay compatibility by treating historical retired events as archived where needed.
- Read models: remove `retired` from Catalog Item filters/status options for new admin flows; keep retired event subscriptions and handlers where required for historical replay.
- APIs: keep `/items/:id/archive` as the active lifecycle endpoint and retire the `/items/:id/retire` client/UI path from active use.
- UI: show one Catalog Item bulk lifecycle action: `Archive`.
- Operations: preview/confirm should report active Catalog Items as ready for archive and block already archived or stale/missing rows.

## Repo Evidence

- `bounded-contexts/catalog/README.md` names Catalog as the owner of Catalog Item identity and lifecycle integration facts, but does not explain a separate Retire business policy.
- `bounded-contexts/catalog/features/catalog-items/domain/domain.ts` currently models `active -> retired -> archived`, but has no reactivation path from retired.
- `bounded-contexts/catalog/features/catalog-items/ui/catalog-item-list-page.tsx` exposes both `Retire` and `Archive` in `lifecycleActions`, creating the duplicated action menu.
- `bounded-contexts/catalog/docs/admin-bulk-workflows.md` says bulk lifecycle actions should orchestrate existing aggregate commands, so the aggregate should own the simplification instead of hiding a split only in the UI.

## Implementation Checklist

- Remove active Catalog Item UI/client use of `retire`.
- Change `ArchiveCatalogItem` to archive active Catalog Items directly; historically retired streams replay as archived.
- Stop publishing new Catalog Item retired integration events.
- Update Catalog read-model projection handlers and tests to treat historical retired as archived only where replay compatibility requires it.
- Remove retired Catalog Item status options from admin list filters and lifecycle actions.
- Update downstream context subscriptions/projections to stop requiring future retired events while tolerating historical replay where necessary.
- Update localization strings and docs for the single Catalog Item archive action.

## Documentation To Promote

- Update `bounded-contexts/catalog/README.md` integration guidance to list only `CatalogItemArchived` for Catalog Item terminal lifecycle publication.
- Update this plan with final verification results and any retained compatibility choices.

## Verification

- `pnpm run deps:install`: passed.
- `pnpm run sandbox:doctor`: passed for sandbox `f3797330`.
- `pnpm --filter @chase-sets/catalog run test`: passed, 146 passed / 4 skipped.
- `pnpm --filter @chase-sets/checkout run test`: passed, 54 passed.
- `pnpm --filter @chase-sets/discovery run test`: passed, 90 passed / 4 skipped.
- `pnpm --filter @chase-sets/inventory run test`: passed, 19 passed / 5 skipped.
- `pnpm --filter @chase-sets/pricing run test`: passed, 15 passed.
- `pnpm run check:localization`: passed.
- `pnpm run check:structure`: passed.
- `pnpm run check:no-any`: passed.
- `pnpm exec tsc -p ./tsconfig.json --noEmit --pretty false`: passed.
- `pnpm run typecheck`: timed out after 10 minutes before producing a result; the direct root TypeScript pass and no-any check both passed.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
