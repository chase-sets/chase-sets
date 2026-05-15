# Align Search Filters

## Intent

Fix the focused Discovery Search control bar so the search field, sort selector, language selector, and clear-filter action share one aligned design-system pattern across desktop and responsive layouts.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-align-search-filters`
- Branch: `codex/align-search-filters-design-system`
- Base: current source repo `HEAD` at worktree creation, `8cc4f1e6`
- Sandbox id: `6c8cb3bc`
- Dependency setup status: `pnpm run deps:install` completed; install reported existing cyclic workspace dependency warnings but no blocker.
- Setup blockers: none found; `pnpm run sandbox:doctor` completed and assigned Marketplace to `http://localhost:10203`.

## Owning Contexts

- Discovery owns Search, Filter State, Sort Order, Result Set presentation, and the search UI slice.
- `packages/design-system` owns the reusable Search control-bar layout so future search/filter rows do not realign each child manually.

## Resolved Decisions

- Keep behavior in Discovery Search because this is Discovery Query presentation, not Marketplace, Catalog, or deployable composition behavior.
- Fix the alignment in the design system by adding an explicit `actions` slot to `SearchControlBar`, keeping deployables thin and avoiding slice-local layout overrides.
- Use existing design-system form and button primitives; do not create custom input/select/button sizing in Discovery.

## Open Questions

- None blocking. The screenshot and current component API make the issue mechanical: mixed label visibility and arbitrary filter children produce inconsistent top alignment.

## Implementation Checklist

- Completed: Add a design-system action slot to `SearchControlBar`.
- Completed: Make top-row search, sort, filters, and actions align to the bottom of field chrome while preserving equal control heights.
- Completed: Update Discovery Search to pass Language as a filter control and Clear filters through the new action slot.
- Completed: Add or update design-system tests to lock in the action slot and layout contract.
- Completed: Run focused design-system and Discovery tests.
- Completed: Run visual verification for the search page at desktop and mobile sizes with the local Marketplace app.

## Verification

- `pnpm --filter @chase-sets/design-system run test` passed.
- `pnpm --filter @chase-sets/discovery run test` passed.
- `pnpm --filter @chase-sets/design-system run typecheck` passed.
- `pnpm run typecheck` passed.
- Visual check passed at `http://localhost:10203/search?q=Bulbasaur` with desktop `1550x720` and mobile `390x844` browser viewports.
- Cleanup completed with `pnpm run dev:down`.
- Publish workflow started after user confirmation: stage explicit scoped files, commit, push, open PR, wait for CI, merge if checks pass, and confirm staging deployment when available.
- Rebased onto `origin/main`; resolved the Discovery Search conflict by preserving the newer mobile filter bar behavior and keeping desktop Language/Clear filters in the design-system-aligned control area.
- Post-rebase `pnpm --filter @chase-sets/design-system run test` passed.
- Post-rebase `pnpm --filter @chase-sets/discovery run test` passed.
- Post-rebase `pnpm --filter @chase-sets/design-system run typecheck` passed.
- Post-rebase `pnpm run typecheck` passed.
- Post-rebase visual check passed at `http://localhost:10203/search?q=Bulbasaur` with desktop `1550x720` and mobile `390x844` browser viewports.
- Post-rebase cleanup completed with `pnpm run dev:down`.

## Documentation To Promote

- Retain this plan with the implementation.
- No glossary or ADR change is needed; no domain language or irreversible architecture decision changes.

## Goal Completion Criteria

- Implementation remains in this worktree and branch.
- Product code uses the design-system control-bar pattern instead of one-off Discovery layout overrides.
- Automated tests cover the design-system contract and Discovery rendering.
- Desktop and mobile visual checks confirm aligned controls and no overlapping text.
- A PR can include this retained plan for reviewer context.
