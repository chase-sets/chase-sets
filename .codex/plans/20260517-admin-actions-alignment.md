# Admin Actions Alignment

## Intent

Combine the Catalog Items bottom lifecycle and bulk-edit action rows into one operator action area, and move the shared alignment rule into the design system so admin bottom action areas align controls and buttons with form-field bottoms.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-admin-actions-alignment`
- Branch: `codex/admin-actions-alignment`
- Sandbox id: `652d7965` (stopped after dev-server smoke attempt)
- Dependency setup status: complete via `pnpm run deps:install`; `pnpm run sandbox:doctor` passed
- pnpm store path: default `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none found; worktree fast-forwarded to `origin/main` because the screenshot UI exists there.

## Owning Contexts

- Catalog owns Catalog Items, Catalog Item lifecycle, Blueprint assignment, and admin Catalog Items UI.
- `packages/design-system` owns reusable visual/action alignment rules used by admin action bars.
- Admin deployables remain thin composition roots; no deployable-owned behavior is planned.

## Resolved Decisions

- Ownership: Catalog feature UI should compose one Catalog Item bottom action area; reusable row alignment belongs in the design system.
- Language: keep Catalog formal terms (`Catalog Items`, `Blueprint ID`, lifecycle action labels) because this is an internal Catalog admin workflow.
- Invariants: action grouping must not change command semantics, preview/confirm behavior, selected-id scope, filter scope, or Catalog lifecycle rules.
- Read models and APIs: no read-model, API, event, or persistence changes are needed.
- UI: lifecycle and bulk-edit controls should share one `BulkActionBar` when the list has selected or matching items. Controls inside that bar should align to the bottom of labeled form fields, matching `FilterBar`.
- Operations: no new operational behavior is introduced.

## Implementation Checklist

- Fast-forward the worktree to `origin/main` so the implementation includes the current Catalog admin bulk workflow. Completed.
- Add or adjust a design-system bottom action layout pattern so action buttons align with form controls. Completed via `BulkActionBar` action alignment.
- Update Catalog Items to render one bottom action area instead of separate lifecycle and bulk-edit bars. Completed by composing extra controls into `BulkLifecycleActionBar`.
- Keep selected-item and matching-filter previews available. Completed for lifecycle, publish, and bulk-edit actions.
- Run focused design-system and Catalog tests or the nearest package checks available in the repo. Completed; no-`any`, design-system typecheck, and admin-web typecheck passed; repo-wide typecheck timed out before completion.

## Documentation To Promote

- No durable domain docs are required because this is a UI composition and design-system pattern refinement.
- Keep this plan with the implementation branch as the durable planning record.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
