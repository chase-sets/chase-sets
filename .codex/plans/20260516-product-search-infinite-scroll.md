# Product Search Infinite Scroll

## Intent

Search should not feel capped at one 24-result page when users browse products. Replace the buyer-facing search result paging experience with an effectively unbounded cursor-loaded Result Set while preserving Discovery ownership of search behavior, filters, facets, and browse presentation.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-product-search-infinite-scroll`
- Branch: `codex/product-search-infinite-scroll`
- Base: current source repo `HEAD` at worktree creation (`db6d5a27`, main was 6 commits behind origin/main)
- Sandbox id: `42abbd20`
- Sandbox URLs: marketplace `http://localhost:7603`, platform API `http://localhost:7612`
- Dependency setup: `pnpm run deps:install` succeeded with existing cyclic workspace dependency warning among Checkout, Ordering, marketplace seed testing, and Discovery.
- Sandbox setup: `pnpm run sandbox:doctor` succeeded and wrote `.env.sandbox.local`.
- Setup blockers: none found.

## Owning Contexts

- Primary owner: Discovery.
- Evidence: `bounded-contexts/discovery/README.md` states Discovery owns browse, search, Search Query behavior, Result Sets, filter state, and facet presentation. `bounded-contexts/discovery/context.json` exposes the marketplace `/search` route from Discovery and declares `search` as a Discovery slice.
- Upstream context: Catalog remains the source of Catalog Item and Product identity only.
- Design-system dependency: any new scrolling control, sentinel, loading affordance, or fallback action must use existing design-system primitives/patterns or be added to the design system first. Product code must not introduce custom UI overrides.
- Deployable role: `marketplace-web` remains a thin route composition root; it must not own search pagination behavior.

## Resolved Decisions

- Use Discovery terminology: Discovery Query, Search Result, Result Set, Filter State, Sort Order, and Relevance. Avoid introducing "product feed" or "catalog pagination" as behavior owners.
- Keep API behavior in `bounded-contexts/discovery/features/search`: the route/API already accepts `cursor` and returns `nextCursor`; the buyer-facing route/UI currently does not consume it.
- Keep the batch size finite, but remove the visible one-page cap. The implementation should load additional batches from `nextCursor` instead of increasing a single `limit` to a large value. This protects latency and low-value card browse economics while letting users keep going.
- Preserve URL-backed Filter State for search text, category, language, sort, and dynamic filters. Cursor-loaded pages should reset when those inputs change.
- Do not rely on offset for the infinite path. Existing offset behavior can remain only as a legacy/deep-link compatibility path if useful during migration.
- Total-count work should be deliberate. The read model avoids count queries unless `includeTotal` or legacy offset is used, so infinite loading should not accidentally reintroduce count work on every cursor fetch.
- Buyer-facing product search should auto-load more results as the user approaches the end of the list, with an accessible fallback button for retry/manual loading when automatic loading cannot run or fails.

## Repo Evidence

- `bounded-contexts/discovery/routes/search.tsx` defines `PAGE_SIZE = 24`, builds API queries with `limit=24` and `offset=(page - 1) * 24`, and passes `page`/`onPageChange` into the UI.
- `bounded-contexts/discovery/features/search/ui/search-page.tsx` defines its own `PAGE_SIZE = 24`, derives `totalPages`, and renders the design-system `Pagination` control.
- `bounded-contexts/discovery/features/search/api/route.ts` accepts `cursor`, `limit`, and `includeTotal`, and returns `nextCursor`.
- `bounded-contexts/discovery/features/search/read-model/queries.ts` supports cursor conditions for relevance, title ascending, title descending, and newest sorts. It fetches `limit + 1`, returns `nextCursor`, and only counts totals when requested or when legacy offset is used.
- `bounded-contexts/discovery/support/ucp-support/catalog.ts` already uses cursor and `next_cursor` for UCP catalog search, confirming cursor semantics are part of the Discovery read contract.
- `bounded-contexts/discovery/docs/dynamic-search-filters.md` says mobile search owns URL-backed Filter State and result-set narrowing in Discovery, while the design system owns reusable mobile filter presentation.

## Open Questions

- None. Planning is complete enough to create the implementation goal.

## Implementation Checklist

- Route contract:
  - Replace the visible page contract with an initial cursor-backed first batch.
  - Stop setting `offset` for normal search route loads.
  - Keep search, category, language, sort, and dynamic filters as stable URL-backed Filter State.
  - Decide whether `page` remains as a legacy input, redirects away, or is ignored after migration.
- Client loading behavior:
  - Add a Discovery-owned cursor loading path that calls `/api/marketplace/items` with the current Discovery Query plus `cursor=<nextCursor>`.
  - Accumulate Search Results in stable order without duplicating `catalog_item_id`s.
  - Reset accumulated results when Discovery Query inputs change.
  - Treat concurrent loads, failed loads, stale responses, and exhausted `nextCursor` explicitly.
- UI:
  - Replace `Pagination` with automatic near-end loading plus an accessible fallback/retry button.
  - Preserve applied filters, result summary, mobile filter drawer behavior, result cards, and saved-search prompt placement.
  - Ensure loading and failure states use design-system `LoadingSpinner`, `Button`, and `Banner` or a new design-system primitive if the pattern must be canonical.
- Read model/API:
  - Validate cursor behavior across all supported Sort Orders.
  - Keep `limit` clamped and finite.
  - Avoid repeat total-count queries on cursor fetches unless the UI truly needs exact total after initial load.
- Realtime:
  - Decide how realtime market patches apply to accumulated results, not only the first batch snapshot.
  - Ensure `snapshotKey` changes when the Discovery Query changes and does not accidentally clear loaded pages on unrelated navigation state.
- Tests:
  - Update route tests that expect `page` reset behavior and pagination controls.
  - Add UI tests for loading the next cursor, exhausting results, query reset, failure retry, and no duplicate cards.
  - Add read-model or API tests proving cursor pagination works for relevance, title asc/desc, and newest.
  - Add accessibility assertions for the loading affordance/fallback action.
- Visual verification:
  - Run marketplace search desktop and mobile visual checks.
  - Verify the result grid does not jump, text does not overlap, filters remain reachable, and loaded batches append cleanly.

## Documentation To Promote

- Update `bounded-contexts/discovery/docs/dynamic-search-filters.md` or add a new Discovery-owned note if the Result Set loading behavior needs durable explanation beyond tests.
- Update `docs/README.md` only if a new owner-owned Discovery doc is added.
- No ADR is currently indicated; this is a context-local UI/read-model behavior choice using an already-present cursor contract.

## Goal Completion Criteria

The later implementation goal must:

- Implement the approved cursor-loaded product search behavior in the feature worktree and branch listed above.
- Keep behavior inside Discovery and keep deployables thin.
- Promote any durable Discovery documentation that reviewers need to understand the decision.
- Run focused automated tests for Discovery search route/UI/read-model behavior and any affected design-system coverage.
- Run typecheck or the nearest feasible workspace verification for touched packages.
- Run mobile and desktop visual checks for marketplace search.
- Submit a PR from `codex/product-search-infinite-scroll`.
- Get CI passing.
- Merge the PR.
- Verify the preview deployment after PR creation, clean it up after merge if applicable, verify staging after merge, and verify production if the merge reaches `main`.
- Retain this plan file with the implementation for review history.

## Implementation Evidence

- Discovery route loading now removes the visible `page` contract from buyer-facing search, redirects legacy `page` query parameters away, and builds initial search queries with `limit=24` and no `offset`.
- Additional Result Set batches load from `/api/marketplace/items` with the active Discovery Query and `cursor=<nextCursor>`.
- Client state accumulates cursor-loaded Search Results, deduplicates by `catalog_item_id`, ignores stale cursor responses after Discovery Query changes, guards concurrent load-more requests, and resets appended batches when search text, Category, Language, Sort Order, or dynamic Filters change.
- Realtime market summary patches apply to the accumulated visible Result Set, including cursor-loaded Search Results.
- `SearchPage` replaced pagination with an IntersectionObserver sentinel, design-system loading and failure states, and an accessible load-more/retry button.
- Discovery search documentation now records cursor-loaded Result Set behavior and the no-offset/count-work expectation.

## Verification Evidence

- `pnpm --filter @chase-sets/discovery run test -- features/search/read-model/queries.test.ts features/search/ui/search-page.test.tsx` passed with 14 tests.
- `pnpm --filter @chase-sets/app-marketplace-web run test -- app/routes/search.test.tsx` passed with 11 tests.
- `pnpm run check:localization` passed.
- `pnpm run check:no-any` passed.
- `pnpm --filter @chase-sets/app-marketplace-web run typecheck` passed.
- `pnpm run verify:typecheck` passed.
- `pnpm --filter @chase-sets/app-marketplace-web run build` passed.
- `pnpm run verify` passed against the final code.
- Desktop marketplace search visual check at `http://localhost:7603/search?q=pikachu` passed with no browser console errors, result cards laid out cleanly, and no pagination shown.
- Mobile marketplace search visual check at `http://localhost:7603/search?q=pikachu` passed with no browser console errors, reachable filter controls, a clean result card layout above bottom navigation, and no pagination shown.
- A final desktop and mobile browser sanity pass after the realtime state adjustment showed no browser console errors, `Pikachu` results present, and no pagination text.

## Remaining Completion Work

- Commit, push, and submit the PR from `codex/product-search-infinite-scroll`.
- Confirm CI passes, merge the PR, and perform preview, staging, and production deployment verification as applicable.
