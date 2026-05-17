# Action Bar Design System

## Intent

Reduce visual density in data-heavy admin bulk action bars by making the design system provide an explicit action hierarchy instead of forcing every action into one peer row.

The immediate trigger is the Catalog admin selected-items bar, where selected count, archive, preview, matching-preview, clear selection, publish-preview, destructive cleanup, blueprint assignment, blueprint ID entry, preview edit, and matching preview compete at the same visual level.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-action-bar-design-system`
- Branch: `codex/action-bar-design-system`
- Sandbox id: `4ab61dda`
- Dependency setup status: `pnpm run deps:install` completed.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none found.

## Owning Contexts

- Catalog owns the affected admin workflows for Catalog Items and Source Observations.
- The design system owns the reusable `BulkActionBar` visual and interaction contract.
- The deployable admin web remains a thin composition host; no deployable-local UI pattern should be introduced.

Repo evidence:

- `bounded-contexts/README.md` says Catalog owns canonical item references and that contexts own UI.
- `bounded-contexts/catalog/context.json` exposes admin routes for `catalog-items` and `source-observations`.
- `packages/design-system/README.md` says data-heavy admin screens should use `DataTable`, `DetailPanel`, `FilterBar`, `BulkActionBar`, and `MetricStrip`.
- `packages/design-system/src/components/data-display/filter.tsx` currently renders `BulkActionBar` as a selected-count block plus a single wrapping action area.
- Catalog consumers live in `bounded-contexts/catalog/features/catalog-items/ui/catalog-item-list-page.tsx` and `bounded-contexts/catalog/features/source-observations/ui/source-observation-list-page.tsx`.

## Resolved Decisions

- Ownership: Update `packages/design-system` first; keep Catalog feature code as a consumer of a reusable pattern.
- Language: Keep existing domain copy such as `Catalog Items selected`, `Preview Publish`, and `Promote selected`; the issue is hierarchy and density, not ubiquitous language.
- UI pattern: Extend `BulkActionBar` to support primary actions, secondary actions, and overflow actions while preserving the existing `actions` prop for compatibility.
- Interaction model: Keep high-frequency safe actions visible; move lower-frequency, advanced, or destructive actions into a compact menu/overflow region. This follows the design-system progressive-disclosure rule for advanced, optional, and risky choices.
- Responsiveness: Preserve sticky behavior, but convert the internal layout to stable regions that wrap predictably on mobile and avoid making every action visually equivalent on desktop.
- Accessibility: Overflow controls must use the canonical design-system `Menu` primitive and accessible button labels rather than route-local CSS or ad hoc dropdown behavior.
- Tests: Add design-system coverage for the new action hierarchy and run Catalog UI tests that cover existing selection workflows.

## Open Questions

None blocking. The screenshot provides enough direction, and the repo already identifies the design system as the canonical owner for this pattern.

## Implementation Checklist

- [x] Extend `BulkActionBar` props and markup for action hierarchy.
- [x] Add or update design-system tests for primary, secondary, and overflow action rendering.
- [x] Update Catalog list pages to use the new grouped action contract.
- [x] Run design-system tests.
- [x] Run Catalog UI tests for catalog items and source observations.
- [x] Run design-system typecheck.
- [x] Run Catalog typecheck.
- [ ] Visually verify the admin Catalog Items surface in the sandbox when feasible. Attempted against sandbox `4ab61dda`; admin web started, but the platform API listener became unavailable and the route returned auth/catalog proxy failures.

## Documentation To Promote

- Update `packages/design-system/README.md` if the new `BulkActionBar` contract needs durable guidance beyond tests and TypeScript props.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
