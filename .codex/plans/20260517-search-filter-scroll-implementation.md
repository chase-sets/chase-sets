# Search Filter Scroll Implementation

## Worktree

- Branch: `codex/search-filter-scroll-implementation`
- Worktree: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-search-filter-scroll-implementation`
- Base: `origin/main` at `77d2a77f` (`[codex] Document search filter UX guidance`)
- Sandbox id: `1826f443`

## User Request

Ensure the design system and search/discovery surfaces follow the no-nested-scroll filtering guidance. Staging still shows nested scrollbars inside desktop filter groups, so documentation alone is insufficient.

## Evidence

- `bounded-contexts/discovery/context.json` declares Discovery owns the search route, search slice, marketplace API path, and marketplace-web route contribution.
- `bounded-contexts/discovery/README.md` and `bounded-contexts/discovery/GLOSSARY.md` define Search Query, Result Set, Filter State, Facets, and Filter as Discovery language.
- `bounded-contexts/discovery/docs/dynamic-search-filters.md` says long option lists use progressive depth, selected filters remain visible, the mobile filter sheet owns vertical scroll, and desktop filter rails may be the single scrollable filter surface.
- `packages/design-system/MARKETPLACE_SYSTEM.md` says marketplace search filters must preserve buyer momentum and long option lists use `Show more` / `Show less` instead of nested scrollbars.
- `packages/design-system/PANEL_INTERACTIONS.md` says persistent filter sidebars and mobile filter sheets must not contain scrollable facet subregions.
- `packages/design-system/src/patterns/app-shells.tsx` still applies `max-h-72 overflow-y-auto pr-1` inside both `MarketplaceFacetRail` and `MarketplaceFacetChoiceGroup` when searchable, which creates the nested desktop and mobile scrollbars seen in staging.
- `bounded-contexts/discovery/features/search/ui/search-page.tsx` already composes Discovery filters through `MarketplaceFacetRail` and `MarketplaceFacetChoiceGroup`, so fixing the design-system primitives should update the Discovery surfaces without deployable-specific overrides.

## Decisions

- Keep the outer desktop filter rail / mobile bottom-sheet body as the only vertical scroll owner.
- Remove inner facet option scroll containers from canonical design-system marketplace filter components.
- Add progressive disclosure to searchable facet groups: show a concise default option set, expose `Show more` / `Show less`, and keep selected values visible even when they fall outside the default set.
- Preserve existing option search behavior across all items. Search results may expand beyond the default set because the parent rail/sheet is the scroll owner.
- Keep Discovery URL-backed filter state and selected-chip behavior unchanged.
- Do not rank facets by fewest options alone. Follow the documented priority model: category first, active groups visible, then buyer decision value and active-result coverage.

## Implementation Plan

1. Update `MarketplaceFacetRail` and `MarketplaceFacetChoiceGroup` in `packages/design-system/src/patterns/app-shells.tsx` to use shared progressive-disclosure helpers.
2. Add optional labels for the progressive disclosure controls with sensible design-system defaults.
3. Add/adjust design-system tests to verify:
   - long searchable facet groups initially hide lower-priority options,
   - selected values remain visible,
   - `Show more` reveals the remaining options and `Show less` collapses them,
   - rendered markup no longer includes the inner `overflow-y-auto` facet option containers.
4. Add/adjust Discovery search UI tests if needed to verify large dynamic facets inherit the canonical behavior.
5. Run focused design-system and Discovery UI tests, then typecheck if the focused tests pass.

## Acceptance Criteria

- No nested scrollbars inside marketplace facet option groups on desktop or mobile.
- Long dynamic filter lists show progressive depth with accessible show-more/show-less controls.
- Selected dynamic filters remain visible in active chips and their owning group.
- Discovery search surfaces continue to compose design-system components without custom filter-scroll overrides.
- Focused tests pass locally in the worktree sandbox.
