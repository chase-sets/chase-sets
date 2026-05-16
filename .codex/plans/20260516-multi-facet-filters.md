# Multi-Facet Filters

## Intent

Allow Discovery users to select multiple values in the same dynamic facet, such as Condition = Near Mint or Lightly Played, while preserving AND behavior between different facet groups. Update the design-system filter controls so multi-select facets are visually and semantically clear.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-multi-facet-filters`
- Branch: `codex/multi-facet-filters`
- Base: `612d59b6` from `main`
- Sandbox id: `df267627`
- Dependency setup: complete via `pnpm run deps:install`
- Sandbox doctor: passed via `pnpm run sandbox:doctor`
- Setup blockers: none known

## Owning Contexts

- Discovery owns Search, Filter State, Facets, result-set narrowing, URL-backed filter behavior, and search UI.
- Catalog remains upstream for Field, Dimension, Option identity and meaning.
- The design system owns reusable marketplace filter presentation and mobile filter sheet patterns.
- Deployables remain thin route composition roots.

## Resolved Decisions

- Dynamic Field and Dimension facets support multiple selected values in the same facet group.
- Multiple values within a single dynamic facet are OR filters.
- Different dynamic facet groups remain AND filters.
- Category and Language remain single-select browse controls.
- Repeated URL parameters remain the canonical contract:
  - `field.<field_id>=<normalized-value>`
  - `dimension.<dimension_id>=<option_id>`
- Labels, display order, and localized copy are presentation only and cannot become durable filter identifiers.
- Search Result links preserve selected Dimension filters on item detail URLs. If multiple options are selected for the same Dimension, Item Detail intentionally leaves that Dimension unset rather than guessing.
- Marketplace facet components expose a `single` or `multiple` selection mode. Dynamic facets use `multiple`; category and language use `single`.

## Repo Evidence

- `bounded-contexts/discovery/GLOSSARY.md` defines Facet, Filter, Filter State, Discovery Query, and Result Set.
- `bounded-contexts/discovery/docs/dynamic-search-filters.md` already documents repeated query parameters, OR within a facet group, AND across groups, result-aware counts, and multi-selection handoff behavior.
- `bounded-contexts/discovery/features/search/read-model/queries.ts` groups Field and Dimension filters and uses `ANY(...)` to match selected values inside one facet group.
- `bounded-contexts/discovery/routes/search.tsx` reads repeated `field.*` and `dimension.*` query parameters and toggles repeated parameter values.
- `packages/design-system/src/patterns/app-shells.tsx` exposes `MarketplaceFacetRail` and `MarketplaceFacetChoiceGroup` with `selectedIds`, but the visible control affordance still reads as generic pressed buttons.

## Stress Checks

- Normal flow: selecting NM and LP on Condition returns items matching either condition and marks both values selected.
- Cross-facet flow: selecting Condition = NM or LP plus Language = English narrows to English items matching either condition.
- Stale data/replay: if a selected Option falls out of the top facet values, URL state remains durable and chips remain reversible using stable IDs.
- Handoff: item detail receives repeated Dimension parameters and applies only dimensions with exactly one selected option.
- Low-value card economics: multi-condition browsing helps buyers compare nearby condition bands without forcing separate searches.

## Implementation Checklist

- [x] Ensure route/API parsing preserves repeated Field and Dimension filters.
- [x] Make design-system marketplace facet controls explicitly support multi-select mode.
- [x] Update Discovery Search UI to opt dynamic facets into multi-select presentation while keeping category/language single-select.
- [x] Add/adjust Discovery UI tests for two selected values in one dynamic facet.
- [x] Add/adjust design-system tests for multi-select facet affordance.
- [x] Run focused tests for Discovery search UI and design system.
- [x] Run typecheck checks after dependency setup.
- [x] Run mobile and desktop visual verification for the search filters.

## Verification

- `pnpm --filter @chase-sets/discovery run test -- search-page.test.tsx`: passed.
- `pnpm --filter @chase-sets/design-system run test -- design-system.test.tsx`: passed.
- `pnpm --filter @chase-sets/design-system run typecheck`: passed.
- `pnpm run verify:typecheck`: passed.
- Desktop browser check at `http://localhost:10353/search?q=pikachu&dimension.dim_seed_condition=chc_seed_condition_near_mint&dimension.dim_seed_condition=chc_seed_condition_excellent`: both selected Condition values were visible as chips and desktop facet buttons reported `aria-pressed="true"`.
- Mobile browser check at 390x844: filter drawer showed Condition summary `2 selected`, selected Excellent and Near Mint rows with check indicators, and both buttons reported `aria-pressed="true"`.
- Dev cleanup: stopped the manually launched platform API and marketplace web processes, then ran `pnpm run dev:down`.

## Documentation To Promote

- Keep `bounded-contexts/discovery/docs/dynamic-search-filters.md` as the canonical behavior note. Update only if implementation finds drift.
- Updated `packages/design-system/MARKETPLACE_SYSTEM.md` with the multi-select facet guidance.

## Goal Completion Criteria

- Implementation lives in this worktree and branch.
- Dynamic facets support multi-select within a facet using repeated URL parameters.
- Design-system filter controls make single-select and multi-select modes clear and reusable.
- Discovery tests and design-system tests cover the behavior.
- Visual checks cover desktop facet rail and mobile filter drawer.
- The retained plan is committed with the implementation.
- A PR is submitted, CI passes, the PR is merged, preview deploy is verified and cleaned up, staging deploy is verified, and production deploy is verified if the merge reaches `main`.
