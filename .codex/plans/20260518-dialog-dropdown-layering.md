# Dialog Dropdown Layering

## Intent

Fix dropdown menus opened inside dialogs so their option panels render above the dialog panel instead of behind it.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-dialog-dropdown-layering`
- Branch: `codex/dialog-dropdown-layering`
- Sandbox id: `3a3d3380`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Affected bounded context: Catalog, specifically the Source Observation TCGdex import flow.
- Behavior owner: `packages/design-system`, because `Dialog`, `Select`, `Combobox`, `Autocomplete`, and popover primitives define reusable panel layering for all contexts.

## Resolved Decisions

- Fix the reusable design-system layer tokens or primitive classes instead of adding a Catalog-only override.
  - Evidence: Catalog owns provider Source Observations and the screenshot shows the Catalog TCGdex import dialog. The dropdown implementation is shared through `packages/design-system/src/components/forms/select.tsx`, which uses `z-popover`; dialogs use `z-modal`.
  - Consequence: every dialog-hosted select benefits without slice-specific CSS.
- Put dropdown/popover layers above modal layers and keep toast above both.
  - Evidence: default design-system layer tokens had `dropdown=30`, `popover=40`, `modal=60`, and `toast=70`, which lets dialog panels cover select panels. The updated order is `modal=60`, `dropdown=65`, `popover=70`, `toast=80`.
  - Consequence: floating selection panels opened from dialogs or modal panels render above their owning panel while notifications remain topmost.
- Keep Catalog terminology unchanged.
  - Evidence: the issue is visual layering only; it does not alter Source Observation, Reference Record, Expansion, Series, or Product language.

## Open Questions

- None. The screenshot and code establish the desired behavior.

## Implementation Checklist

- [x] Inspect design-system dialog and overlay primitives.
- [x] Patch layer ordering so dropdown-like floating panels can appear above modal panels.
- [x] Add or update design-system tests that lock the modal/dropdown ordering.
- [x] Run targeted checks for the design-system package.

## Documentation To Promote

- None expected. This is an implementation bug in existing design-system primitives, not a new product/domain decision.

## Verification

- `pnpm run sandbox:doctor` passed for sandbox `3a3d3380`.
- `pnpm run test:design-system` passed with 2 files and 114 tests.
- `pnpm --filter @chase-sets/design-system run typecheck` passed.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
