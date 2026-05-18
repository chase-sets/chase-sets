# Bulk Action Command Bar

## Intent

Redesign the Catalog Items selected-action area as a scoped bulk action command bar: selection defines scope, operation defines intent, preview validates impact, and apply commits the change.

The immediate UI problem is visible in the provided desktop and mobile screenshots: selected Catalog Items currently expose lifecycle, publish, matching-scope, destructive, and bulk edit controls together. The result is cognitively dense even when the desktop bar is wide, and mobile becomes a tall action card that competes with the item cards and bottom navigation.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-multiselect-workflows`
- Branch: `codex/multiselect-workflows`
- Base: existing screenshot-matching local worktree at `f46885a0`
- Sandbox id: `80f54be4`
- Dependency setup status: `pnpm run deps:install` completed; `pnpm run sandbox:doctor` passed
- pnpm store path: default embedded worktree store `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none found yet

## Owning Contexts

- Owner: Catalog bounded context.
- Slice: `bounded-contexts/catalog/features/catalog-items`.
- Support surface: `bounded-contexts/catalog/support/shell-support/ui` only if the shared bulk lifecycle/action shell must be changed for multiple Catalog slices.
- Deployable: `admin-web` is a thin composition root through Catalog manifest routes and should not own this behavior.

Repo evidence:

- `bounded-contexts/README.md` says Catalog owns the canonical product model for what can be bought or sold.
- `bounded-contexts/catalog/README.md` says Catalog owns `Catalog Item`, `Blueprint`, lifecycle commands such as publish/archive, field values, and category membership.
- `bounded-contexts/catalog/context.json` declares `catalog-items` as a Catalog slice and contributes `/catalog-items` to `admin-web`.
- `docs/architecture/bounded-context-structure.md` says bounded contexts own their own UI and deployables stay thin.
- `bounded-contexts/catalog/docs/bulk-catalog-item-publish.md` says bulk publish must preview to an explicit Catalog Item ID set and confirm the previewed IDs, not a freshly evaluated filter.

## Resolved Decisions

- Implementation base: target the screenshot-matching `codex/multiselect-workflows` work rather than local `main`.
- The UI should treat selected Catalog Items as a scoped command workflow, not a form exposing every possible operation.
- Only one selected operation should be configured at a time.
- Operation-specific inputs must appear only when relevant, for example Blueprint ID only for Assign blueprint.
- Preview copy must name the operation and scope. Use labels like `Preview publish`, `Preview blueprint assignment`, `Review 2 selected Catalog Items`, or `Preview filtered drafts`; avoid duplicate generic `Preview matching`.
- Destructive actions such as archive and remove drafts should not be co-equal default row controls. They should be selected operations or live in a More actions menu with a confirmation step.
- Filter-wide matching scope must stay visually separate from selected-item scope unless the user explicitly switches to that scope.
- Desktop should use one sticky command bar with selection state, operation selector, operation fields, secondary preview, and one primary apply/review action.
- Mobile should use a compact sticky selection bar plus a bottom sheet for operation-specific controls.
- Preview and confirmation dialogs/sheets remain the guardrail for publish/archive/remove workflows; the command bar should launch those flows rather than committing risky actions inline.

## Open Questions

None currently blocking.

Resolved branch-base question: target `codex/multiselect-workflows` because it directly contains the dense selected-action controls shown in the screenshots.

Repo evidence retained:

- Local `main`: `bounded-contexts/catalog/features/catalog-items/ui/catalog-item-list-page.tsx` only had selected `Preview Publish` plus `Clear selection`.
- `codex/multiselect-workflows`: the same file composes selected publish, `BulkLifecycleActionBar`, and a second bulk edit `BulkActionBar` with Assign Blueprint and `Preview matching`.
- `codex/multiselect-workflows`: `contracts/localization/locales/en.ts` contains `Preview Edit` and duplicate `Preview matching` labels that appear in the screenshots.

## Implementation Checklist

- Completed: Kept behavior in Catalog `catalog-items`; no shared design-system primitive was needed.
- Completed: Modeled selected bulk operation state in the list page.
- Completed: Defined selected operations for publish, retire, archive, and existing bulk edit operations with operation-specific fields and labels.
- Completed: Replaced stacked/coexisting selected bulk bars with one selected command-bar composition.
- Completed: Added a mobile compact selected bar and design-system bottom sheet using existing `BottomSheet`, `Button`, `Select`, `TextInput`, `Inline`, and `Stack`.
- Completed: Moved filter-wide preview/matching actions out of the selected-item command flow; they render only when no rows are selected.
- Completed: Updated localization labels to operation-specific copy and removed duplicate generic `Preview matching` from selected controls.
- Completed: Preserved preview-confirm semantics for bulk publish, lifecycle, and edit operations.
- Completed: Updated Catalog Items UI tests for selected operation changes, operation-specific inputs, renamed labels, and scope-specific preview calls.
- Not needed: Design-system tests, because no shared design-system primitive changed.
- Completed: Verified with focused unit test, localization check, root TypeScript check, and desktop/mobile browser inspection.

## Stress Test Notes

- Normal flow: operator selects rows, chooses one operation, previews exact affected Catalog Item IDs, then confirms.
- Partial flow: preview can show ready and blocked rows; apply acts on previewed IDs only.
- Stale data or replay: confirmation must continue using previewed IDs and server-side Catalog validation.
- Cross-context handoff: none; Catalog owns these operations and should publish facts downstream through existing Catalog events only when domain state changes.
- Failure/cancellation: canceling preview or bottom sheet must leave row selection intact unless an apply succeeds.
- Low-value card economics: efficient bulk publish/edit remains important because low-value card margins require fast catalog operations without sacrificing scoped precision.

## Documentation To Promote

- Consider a Catalog context note under `bounded-contexts/catalog/docs/` only if this becomes a durable bulk-operation policy beyond UI structure.
- Consider design-system documentation only if a reusable command bar primitive is introduced.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
