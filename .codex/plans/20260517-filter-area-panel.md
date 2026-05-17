# Filter Area Panel

## Intent

Catalog Items has enough filters that the current always-visible filter bar becomes noisy and wraps poorly. Add a reusable design-system filter area that keeps a small number of primary filters visible and automatically moves overflow filters into a filter panel. Apply it to Catalog admin list pages through the Catalog-owned shell support so the deployable stays a thin composition root.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-filter-area-panel`
- Branch: `codex/filter-area-panel`
- Sandbox id: `0de53bf1`
- Dependency setup status: complete via `pnpm run deps:install`; `pnpm run sandbox:doctor` passed
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none
- Cleanup status: `pnpm run dev:down` stopped the sandbox after the dev-server bootstrap attempt

## Owning Contexts

- Catalog owns the Catalog Items admin route, query language, read model filters, and UI usage.
- Design System owns the reusable filter area, overflow trigger, side sheet, bottom sheet fallback, and layout behavior.
- Deployables remain composition roots only; no route behavior should move into `deployables/`.

## Resolved Decisions

- Ownership: implement the reusable component in `packages/design-system/src/components/data-display/filter.tsx`; consume it from `bounded-contexts/catalog/support/shell-support/ui/entity-list-page.tsx`.
- Language: use generic design-system copy for the component (`Filters`, `Apply filters`) and Catalog-local labels for individual filters (`Catalog Item`, `Blueprint`, `Tag`, etc.).
- Behavior: default to a compact visible row with configurable primary filters and route overflow filters into a panel. On desktop, use a side sheet; on narrow screens, use a bottom sheet through existing design-system sheet primitives.
- Catalog implementation: keep search and status primary for list pages; move extra filters into overflow once the caller provides more filters than the primary budget.
- Query state: no new domain invariant or event is needed; this is UI composition over existing request/query filters.
- Accessibility: trigger exposes active/overflow counts, panel content is labeled, and all filter controls remain real form controls rendered by the caller.
- Verification: focused design-system and Catalog list tests passed; root localization and typecheck checks passed.
- Visual smoke: admin-web dev startup was attempted at `http://localhost:11052`, but sandbox bootstrap stopped during `@chase-sets/app-platform-worker` with exit status `3221226505` before the web route listened.

## Open Questions

- None blocking. The implementation can use a conservative default threshold of two primary filters because Catalog list pages already treat search and status as the common controls.

## Implementation Checklist

- [x] Add a `FilterArea` design-system component that accepts primary filters, overflow filters, optional actions, active count, labels, and a primary visible limit.
- [x] Preserve `FilterBar` and `FilterBottomSheet` for existing callers.
- [x] Update design-system exports and tests.
- [x] Update Catalog shell list page to use the responsive area.
- [x] Expand Catalog Items filters to expose the existing `blueprintId` and `tag` query filters in the panel.
- [x] Verify design-system tests and focused Catalog UI tests.

## Documentation To Promote

- Keep this plan with the implementation.
- No durable architecture doc appears necessary unless follow-up work standardizes all admin list pages around the new component.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
