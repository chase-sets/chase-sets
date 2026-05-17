# Search Filter Disclosure

## Intent

Remove the accordion/progressive-disclosure treatment around dynamic filters on the Discovery search page. Dynamic Field and Dimension facets are ranked browse controls, so they should stay visible as top-level filter groups in both desktop and mobile search filtering.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260516-search-filter-disclosure`
- Branch: `codex/search-filter-disclosure`
- Sandbox id: `14a6e7f3`
- Dependency setup status: `pnpm run deps:install` completed successfully.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox status: `pnpm run sandbox:doctor` completed successfully. Marketplace web is assigned to `http://localhost:9953`.
- Setup blockers: none.

## Owning Contexts

- Discovery owns search query behavior, filter state, facet presentation, browse-oriented read models, and the marketplace search route.
- Catalog owns Field, Dimension, Option, Blueprint, and Product identity. Discovery may project these facts into browse facets without owning their upstream meaning.
- Checkout owns Cart mutations for the bulk Result Set handoff; this change does not alter that boundary.
- The design system owns reusable filter-shell and facet-control primitives. The search page should compose those primitives without local visual overrides.

## Resolved Decisions

- Ownership: Discovery is the behavior owner because `bounded-contexts/discovery/README.md` lists filter state and facet presentation under Discovery, and `bounded-contexts/discovery/context.json` declares the `search` route and slice.
- Language: keep the canonical terms `Facet`, `Filter`, `Filter State`, `Discovery Query`, and `Result Set` from `bounded-contexts/discovery/GLOSSARY.md`. Do not introduce `advanced filtering` as a domain term for ranked dynamic facets.
- UI: remove `ProgressiveDisclosureGroup` from `SearchPage` mobile filters. Render each dynamic facet as a top-level `MarketplaceFacetChoiceGroup`, matching the existing desktop `MarketplaceFacetRail` behavior.
- Applied state: keep reversible applied chips unchanged. Multiple dynamic facet values remain URL-backed repeated query parameters and continue using the marketplace `multiple` selection mode.
- API/read models/events: no schema, API, event, projection, or read-model changes are required. The existing result-aware facets already carry selected state and counts.
- Documentation: align design-system progressive-disclosure guidance with Discovery's durable dynamic-search-filter note. Current design-system docs still list dynamic advanced facets as disclosure candidates, while `bounded-contexts/discovery/docs/dynamic-search-filters.md` already says ranked dynamic facets are top-level filters.

## Repo Evidence

- `bounded-contexts/README.md`: Discovery owns browse, search, and detail discovery experiences and may project browse-oriented read models.
- `bounded-contexts/discovery/README.md`: Discovery owns search query behavior, search relevance, browse read models, filter state, and facet presentation.
- `bounded-contexts/discovery/GLOSSARY.md`: `Facet` and `Filter` are Discovery terms; `Filter State` is the selected set of Filters shaping the active Result Set.
- `bounded-contexts/discovery/docs/dynamic-search-filters.md`: "The default search UI shows the ranked dynamic facet groups and their ranked values as top-level filters" and mobile filters present "top-level vertically grouped choices" for dynamic facets.
- `bounded-contexts/discovery/features/search/ui/search-page.tsx`: desktop dynamic facets are already top-level rails, but mobile wraps dynamic facets in `ProgressiveDisclosureGroup` titled `Advanced filters`.
- `packages/design-system/MARKETPLACE_SYSTEM.md` and `packages/design-system/PROGRESSIVE_DISCLOSURE.md`: current guidance treats dynamic advanced facets as disclosure content, which conflicts with Discovery's current product decision.

## Stress Test

- Normal flow: buyers opening mobile filters see Category, Language, and ranked dynamic facets without expanding an accordion.
- Partial flow: active dynamic filters remain visible as chips outside the sheet and selected buttons inside the sheet.
- Stale data/replay: no event or projection behavior changes; stale facet counts continue to refresh through existing route data and realtime patch paths.
- Cross-context handoff: Discovery still sends selected Dimension filters to Detail Page links; Field filters remain Discovery-only Result Set scope.
- Failure/cancellation: mobile sheet cancel/close behavior is unchanged; no new mutation or persistence path is introduced.
- Low-value card economics: making dynamic facets visible shortens filtering for condition/product-defining options, reducing buyer friction on low-value cards where quick refinement matters.

## Implementation Checklist

- [x] Remove `ProgressiveDisclosureGroup` import and usage from `bounded-contexts/discovery/features/search/ui/search-page.tsx`.
- [x] Render dynamic facets in the mobile bottom sheet as top-level `MarketplaceFacetChoiceGroup` sections.
- [x] Update SearchPage tests to assert dynamic facets are not under `Advanced filters`/accordion disclosure and remain interactive.
- [x] Align design-system docs so dynamic result-shaping search facets are not recommended for progressive disclosure.
- [x] Run focused Discovery search UI tests.
- [x] Run static/type verification appropriate to the changed surface.

## Documentation To Promote

- Update `packages/design-system/MARKETPLACE_SYSTEM.md` to distinguish required result-shaping facets from optional advanced depth.
- Update `packages/design-system/PROGRESSIVE_DISCLOSURE.md` for the same distinction.
- No new ADR is needed; this is an alignment of existing Discovery behavior documentation and design-system pattern guidance, not a hard-to-reverse architecture decision.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
