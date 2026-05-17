# Facet Option Search

## Intent

Some Discovery facets contain more option values than the search filter panel can comfortably display. Buyers need a fast, local way to find a specific facet option without leaving the search and filter flow.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-facet-option-search`
- Branch: `codex/facet-option-search`
- Sandbox id: `efa12065`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known; `pnpm run sandbox:doctor` passed

## Owning Contexts

- Discovery owns search query behavior, filter state, facet presentation, and the `features/search` slice.
- Catalog remains upstream for canonical field and dimension facts.
- The design system owns the reusable marketplace facet-choice pattern, so the search input belongs there and Discovery should consume it without custom visual overrides.

## Resolved Decisions

- Ownership: keep the behavior in Discovery search UI, with the reusable control surface added to `MarketplaceFacetChoiceGroup`.
- Language: use existing Discovery terms: Facet, Filter, Filter State, and Result Set.
- Invariants: filtering within a facet option list is panel-local UI state only; it must not mutate the Discovery Query until a buyer selects an option.
- Read model/API: keep the response shape stable, but return a larger bounded option set for each chosen facet and sort selected values to the top before popularity so panel-local search can reach options beyond the old visible slice.
- UI: add an optional search box to facet choice groups when a facet has enough options to benefit from it, keep selected options visible even when they do not match the local search, and show an empty state when no option labels match.
- Operations: no new event, projection, or deployment behavior is introduced.

## Open Questions

- None blocking. The conservative implementation searches within the currently loaded facet options. A later server-backed facet option lookup can be added if users need options beyond the API's returned top values.

## Implementation Checklist

- Add optional search affordance to `MarketplaceFacetChoiceGroup`.
- Use the affordance from Discovery's dynamic facet groups in desktop rail and mobile bottom-sheet flows.
- Add localization keys for search placeholder and no-match copy.
- Cover the design-system behavior with tests.
- Run targeted verification after dependency setup.

## Documentation To Promote

- None required for this narrowly scoped UI enhancement. If server-backed facet option lookup is added later, promote a Discovery context note for facet option discovery semantics.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
