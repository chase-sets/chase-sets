# Fix Catalog Items Events Canceling

## Intent

Stop the Catalog Items admin page from repeatedly canceling and reopening the Catalog admin realtime events request during normal loader refreshes.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-fix-catalog-items-events-canceling`
- Branch: `codex/fix-catalog-items-events-canceling`
- Sandbox id: `37c69cb6`
- Dependency setup: `pnpm run deps:install` completed.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none. `pnpm run sandbox:doctor` completed.

## Owning Contexts

- Catalog owns the Catalog Items admin route, Catalog admin realtime topics, authorization policy, and projection invalidation semantics.
- Platform runtime owns the shared SSE transport, but the observed cancellation loop is triggered by Catalog's route-level revalidation hook lifecycle.
- Deployables remain thin composition roots and should not own this behavior.

## Resolved Decisions

- Ownership: keep the fix in Catalog `shell-support` because the hook is Catalog-owned route behavior shared by Catalog admin slices.
- Language: keep formal `Catalog Item` terminology in docs and tests; endpoint names remain `events` and topic names remain `catalog:admin:catalog-items`.
- Invariants: the fix must not change Catalog Item domain events, read models, projection contents, or list query semantics.
- Events: keep using the existing `catalog:admin:catalog-items` topic and `projection.patch` / `sync.required` messages.
- Read models: keep the loader as the server source of truth for filtering, pagination, and bulk scopes.
- APIs: no new endpoint or route shape is needed.
- UI: no design-system change is needed; only the subscription lifecycle should become stable across revalidations.
- Operations: the normal SSE stream should remain open across loader rerenders and only close when the route unmounts or topics change.

## Repo Evidence

- `bounded-contexts/catalog/routes/admin/catalog-items.tsx` subscribes with `useCatalogRealtimeRevalidation(catalogRealtimeRouteTopics.catalogItems())`.
- `bounded-contexts/catalog/support/shell-support/ui/realtime-revalidation.ts` includes the whole `revalidator` object in its effect dependencies.
- React Router can provide a new object identity across route refreshes; that causes the effect cleanup to close the shared `EventSource`, which appears in DevTools as a canceled `events?topic=catalog%3Aadmin%3Acatalog-items` request.
- `infrastructure/platform-runtime/realtime-web.ts` already coalesces subscriptions by topic set, so the stable fix is to avoid resubscribing when only callback object identity changes.

## Implementation Checklist

- Completed: store the latest `revalidator.revalidate` callback in a ref inside `useCatalogRealtimeRevalidation`.
- Completed: remove the unstable revalidator object from the subscription effect dependency set.
- Completed: add a regression test that rerendering with a new revalidator object does not close and resubscribe the Catalog realtime stream.
- Completed: run targeted Catalog shell-support tests.
- Completed: run full Catalog tests.
- Completed: run repo typecheck.
- Not needed: platform realtime-web tests; the shared transport was not changed.

## Verification

- `pnpm --filter @chase-sets/catalog run test -- support/shell-support/ui/realtime-revalidation.test.tsx`: passed, 3 tests.
- `pnpm --filter @chase-sets/catalog run test`: passed, 183 tests and 4 skipped across 29 files.
- `pnpm run verify:typecheck`: passed.

## Documentation To Promote

- No durable docs promotion expected; the existing Catalog admin bulk workflow note already describes the intended realtime behavior.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
