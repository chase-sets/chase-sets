# Infinite Scroll Empty Results

## Intent

Stop Discovery search infinite scroll from repeatedly requesting another Result Set batch after the server has already reported that no remaining Search Results exist.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260516-infinite-scroll-empty-results`
- Branch: `codex/infinite-scroll-empty-results`
- Sandbox id: `20260516-infinite-scroll-empty-results`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Discovery owns Search Query behavior, Result Sets, Search Results, cursor loading, search UI, and browse-oriented read models.
- Deployables compose the Discovery route only and must stay thin.

## Resolved Decisions

- Ownership: implement the fix inside the Discovery search route/UI slice, not in marketplace deployable code.
- Language: keep canonical terms `Discovery Query`, `Result Set`, `Search Result`, and `nextCursor`.
- Invariant: a Result Set with appended pages must preserve an explicit `null` `nextCursor` from the latest fetched page; `null` means there are no remaining results and must not fall back to an older cursor.
- Events/read models: no new events or projection changes are needed. The read model already returns `nextCursor: null` when `hasNextPage` is false.
- API: keep the existing cursor API contract. The client merge logic should respect the API response instead of manufacturing a cursor.
- UI: keep automatic observer loading and the accessible load-more fallback, but stop both once merged data has no `nextCursor`.
- Operations: verify with focused Discovery route/UI tests. No durable doc promotion is needed because this is a bug fix to existing documented behavior.

## Repo Evidence

- `bounded-contexts/discovery/README.md` says Discovery owns search query behavior, browse read models, and filter/facet presentation.
- `bounded-contexts/discovery/GLOSSARY.md` defines `Discovery Query`, `Search Result`, and `Result Set`.
- `bounded-contexts/discovery/docs/dynamic-search-filters.md` says additional batches use returned `nextCursor`, append Search Results, deduplicate by `catalog_item_id`, and clear appended cursor batches when the query changes.
- `bounded-contexts/discovery/features/search/read-model/queries.ts` fetches `limit + 1` rows and returns `nextCursor: null` when no next page exists.
- `bounded-contexts/discovery/routes/search.tsx` merges pages but currently uses `extraPages.at(-1)?.nextCursor ?? firstPage.nextCursor`, which can resurrect the first page cursor when the latest fetched page explicitly returns `null`.

## Implementation Checklist

- [x] Set up worktree dependencies and run sandbox doctor.
- [x] Change Discovery search response merging so latest appended page `nextCursor: null` is terminal.
- [x] Add route-level regression coverage proving a completed final page does not fetch the same cursor again.
- [x] Run focused tests for the Discovery search route/UI.
- [x] Update this plan with verification results.

## Documentation To Promote

None. Existing Discovery docs already describe the desired Result Set loading behavior.

## Goal Completion Criteria

- Infinite scroll no longer continues network requests after the final cursor page returns `nextCursor: null`.
- Manual fallback no longer remains available after the final cursor page has been merged.
- Focused tests pass from the worktree.
- Plan remains in `.codex/plans/20260516-infinite-scroll-empty-results.md`.

## Verification

- `pnpm run deps:install`
- `pnpm run sandbox:doctor` reported sandbox id `c87f1841`.
- `pnpm --filter @chase-sets/app-marketplace-web run test -- app/routes/search.test.tsx`
- `pnpm --filter @chase-sets/discovery run test -- features/search/ui/search-page.test.tsx`
- `pnpm --filter @chase-sets/app-marketplace-web run typecheck`
