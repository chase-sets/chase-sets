# Search Filter UX

## Intent

Infinite scroll made desktop search harder to filter because the left filter rail can outgrow the viewport while results continue loading. Search needs a desktop and mobile filter experience that keeps the most relevant dynamic filters easy to reach, with no progressive disclosure in this spot.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260516-search-filter-ux`
- Branch: `codex/search-filter-ux`
- Sandbox id: `b6e94c14`
- Dependency setup status: `pnpm run deps:install` completed successfully
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known; `pnpm run sandbox:doctor` completed successfully

## Owning Contexts

- Discovery owns the implementation. Repo evidence: `bounded-contexts/discovery/README.md` says Discovery owns search query behavior, filter state, facet presentation, and search UI. `bounded-contexts/discovery/GLOSSARY.md` defines Discovery Query, Facet, Filter, Filter State, Result Set, and Sort Order.
- Catalog remains upstream truth only. Repo evidence: `bounded-contexts/discovery/docs/dynamic-search-filters.md` says Catalog owns Field, Dimension, Option, Blueprint, and Product identity while Discovery owns filter presentation, ranking, query normalization, and counts.
- The marketplace deployable stays a thin composition root. Repo evidence: `docs/architecture/bounded-context-structure.md` says bounded contexts own route modules and UI while deployables compose routes.

## Resolved Decisions

- Ownership: implement in `bounded-contexts/discovery/features/search/ui/search-page.tsx` and tests; update Discovery docs where the existing disclosure guidance conflicts with the new product direction.
- Language: keep canonical terms `Facet`, `Filter`, `Filter State`, `Result Set`, and `Discovery Query`.
- Invariants: filtering remains URL-backed and stable-ID based. Field filters continue to use `field.<field_id>`; Dimension filters continue to use `dimension.<dimension_id>`.
- Events/read models/APIs: no event, projection, or API contract change. Dynamic facet relevance continues to come from the current `DiscoverySearchResponse.facets`.
- UI: remove `ProgressiveDisclosureGroup` from search filters. Category, language, and each ranked dynamic facet group appear as top-level groups.
- Desktop: keep the left search rail but make it an independently scrollable sticky filter surface so all top-level filters remain reachable while cursor-loaded results grow.
- Mobile: keep the canonical mobile filter bar and bottom-sheet drawer, but render every dynamic facet as its own top-level choice group.
- Operations: no database or replay action is needed because this is a presentation and documentation change.

## Stress Test

- Normal flow: buyers can refine Category, Language, and dynamic facets without opening nested sections.
- Partial flow: if no dynamic facets are returned, Category and Language remain usable.
- Stale data/replay: facets are still rendered from the current Result Set response; stale labels do not become durable IDs.
- Cross-context handoff: Dimension filters still carry to item detail; Field filters still do not define Product selection.
- Failure/cancellation: load-more failures still keep filters accessible because filter controls do not depend on cursor fetch success.
- Low-value card economics: faster filtering supports low-value card margin goals by reducing repeated browse work and keeping ranked high-signal facets visible.

## Implementation Checklist

- [x] Run dependency setup and sandbox doctor in the worktree.
- [x] Replace nested progressive disclosure with top-level dynamic facet groups in desktop and mobile search UI.
- [x] Improve desktop rail reachability for long filter sets during infinite scroll.
- [x] Update focused Discovery search UI tests.
- [x] Update dynamic filter documentation to match top-level ranked filters.
- [x] Run focused verification.

## Verification

- `pnpm --filter @chase-sets/discovery run test -- features/search/ui/search-page.test.tsx`
- `pnpm --filter @chase-sets/app-marketplace-web run test -- app/routes/search.test.tsx`
- `pnpm --filter @chase-sets/design-system run typecheck`
- `pnpm --filter @chase-sets/design-system run test`
- `pnpm --filter @chase-sets/discovery exec tsc --noEmit --pretty false`
- `pnpm --filter @chase-sets/app-marketplace-web run typecheck`
- Browser DOM check at `http://localhost:10003/search?q=pikachu`: desktop rail renders top-level Category and Language filters, and no `Advanced filters` disclosure text is present.

## Documentation To Promote

- Keep this retained plan with the implementation.
- Update `bounded-contexts/discovery/docs/dynamic-search-filters.md` because the prior disclosure guidance conflicts with the new UI decision.

## Goal Completion Criteria

- Search filter UI ships from the Discovery bounded context.
- Desktop filters remain reachable during cursor-loaded browsing.
- Mobile filters remain in the canonical sheet with all dynamic facets top-level.
- No progressive disclosure remains in this search filter spot.
- Focused tests and docs pass/update.
