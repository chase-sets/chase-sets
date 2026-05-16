# Bulk Promote Source Observations

## Intent

Improve the Catalog admin Source Observations screen so operators can promote many reviewed TCGdex observations in one workflow instead of opening each observation detail page and promoting records one at a time.

The implementation should preserve the review-first Catalog policy: provider data remains a Source Observation until a Catalog operator explicitly promotes it into draft Catalog Items. Bulk promotion should reduce repetitive clicks without turning TCGdex ingestion into automatic canonical truth.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-bulk-promote-source-observations`
- Branch: `codex/bulk-promote-source-observations`
- Base: created from local `main` HEAD `8cc4f1e6 Add notifications database to staging platform (#72)`, then fast-forwarded to `origin/main` `871a32ec` because local `main` did not contain the merged TCGdex Source Observations integration.
- Sandbox id: `208d7969`
- Port base: `9650`
- Admin web: `http://localhost:9652`
- Dependency setup: `pnpm run deps:install` completed successfully.
- Sandbox doctor: `pnpm run sandbox:doctor` completed successfully.
- Setup caveats: `pnpm` reported existing cyclic workspace dependencies among checkout, ordering, marketplace-seed-testing, and discovery; no setup failure.

## Owning Contexts

- Catalog owns this feature because Source Observation is a Catalog term and Catalog owns provider-fed candidate facts, canonical Catalog Item promotion, Source Observation state transitions, and the admin review UI.
- Inventory is not an owner. It consumes promoted Catalog facts for stock/import workflows but does not decide whether provider observations become Catalog Items.
- Discovery and Pricing remain downstream. They must not ingest TCGdex directly or participate in bulk promotion.
- Deployables remain thin composition roots; the source-observations slice under `bounded-contexts/catalog/features/source-observations/` should own behavior, read models, API, UI, and tests.

## Resolved Decisions

- Keep bulk promotion inside the existing Catalog `source-observations` slice.
- Keep the canonical action named `Promote Source Observation`; bulk promotion is an application service/API operation that invokes the same per-observation Catalog promotion behavior for each eligible observed record.
- Do not add automatic promotion after TCGdex import in this feature.
- Only observations with status `observed` are eligible. `promoted` and `rejected` records remain terminal and should be skipped or reported, never forced through.
- First iteration bulk promotion applies only to rows the operator explicitly selects, not every row matching the current filters.
- Use design-system table selection and `BulkActionBar` patterns instead of custom list controls.
- Add focused tests around partial success, terminal-state protection, UI selection behavior, and the bulk API/client contract.

## Repo Evidence

- `bounded-contexts/README.md` says Catalog owns canonical product truth and downstream contexts consume Catalog facts through stable IDs and events.
- `bounded-contexts/catalog/README.md` now lists Provider Source Observations as Catalog-owned and says promotion emits Catalog Item commands while Source Observations are not downstream truth until promoted.
- `bounded-contexts/catalog/GLOSSARY.md` defines Source Observation as a provider-sourced candidate record reviewed before it becomes Catalog truth.
- `bounded-contexts/catalog/context.json` includes `source-observations` as a Catalog slice and routes it into `admin-web` at `/source-observations`.
- `bounded-contexts/catalog/docs/source-observation-integration.md` states external providers never write canonical Catalog Items directly and operators promote or reject observations after review.
- `bounded-contexts/catalog/features/source-observations/api/runtime.ts` exposes `promoteObservation` for a single observation and creates a draft Catalog Item, assigns the Pokemon blueprint/category/fields/tags/images, links the TCGdex external reference, emits `catalog.source-observation.promoted`, and drains projectors.
- `bounded-contexts/catalog/features/source-observations/api/route.ts` exposes only `POST /:id/promote` and `POST /:id/reject`; there is no bulk route.
- `bounded-contexts/catalog/features/source-observations/ui/source-observation-list-page.tsx` imports and filters observations but does not allow selection or bulk actions.
- `bounded-contexts/catalog/features/source-observations/ui/source-observation-detail-page.tsx` is the only promote/reject UI, which creates the current one-record-at-a-time workflow.
- `packages/design-system/src/components/data-display/data-table.tsx` already supports `selectedKeys` and `onSelectionChange`.
- `packages/design-system/src/components/data-display/filter.tsx` already exports `BulkActionBar`, and `packages/design-system/README.md` names `DataTable`, `FilterBar`, and `BulkActionBar` as data-heavy admin screen primitives.

## Open Questions

- None for the first implementation slice.

## Settled Recommendation

Promote explicitly selected rows only for the first iteration.

Why it matters: promotion creates draft Catalog Items and external product mappings. That is intentionally reversible through draft review, but still creates canonical Catalog records. Explicit selection keeps operator intent visible and makes partial failures easier to understand.

Repo evidence: Source Observation policy requires operator review before promotion; the design system already supports selected table rows plus a bulk action bar; the current list page has server-side filters and pagination, so "all filtered rows" could silently affect records not visible on the current page.

Accepted answer: selected rows.

Consequence of choosing differently later: promoting all filtered rows would be faster for whole-set imports, but it would require stronger safeguards such as a confirmation summary, count-by-status preview, server-side filter snapshot, and probably conflict/dry-run reporting before executing.

## Implementation Checklist

- Completed: Added a bulk promotion application service to the Catalog source-observations runtime.
- Completed: Added a `POST /source-observations/bulk-promote` API that accepts explicit observation IDs and returns per-record outcomes plus aggregate counts.
- Completed: Added client/UI contracts for bulk promotion results.
- Completed: Updated the Source Observations list page to allow selecting eligible observed rows, show a design-system `BulkActionBar`, and trigger bulk promotion from the list.
- Completed: Terminal observations are excluded from submitted bulk selections in the UI and reported as skipped if submitted to the API.
- Completed: Preserved detail-page single promotion and rejection behavior.
- Completed: Added localization keys for selected count, bulk promote action, completion toast, and failure messaging.
- Completed: Added focused route and list-page selection tests. Runtime outcome behavior is covered through the route contract plus the Catalog source-observation runtime implementation path; broader database-backed promotion behavior remains covered by existing source-observation and catalog authoring tests.
- Completed: Ran focused Catalog and design-system tests, full non-database workspace tests, localization/structure/typecheck checks, production build, and `git diff --check`.
- Completed: Verified the admin Source Observations screen on desktop and mobile. Desktop select-all selected the 50 eligible visible rows and showed the bulk action bar. Mobile selected one visible Source Observation card, showed the action bar above the bottom nav without overlap, promoted the selected observation, cleared selection, and displayed the success toast.

## Verification Evidence

- `pnpm --filter @chase-sets/catalog run test`: passed, 14 files passed and 1 skipped; 109 tests passed and 2 skipped.
- `pnpm --filter @chase-sets/design-system run test`: passed, 2 files and 88 tests.
- `pnpm run check:localization`: passed for 387 source files.
- `pnpm run check:structure`: passed.
- `pnpm run verify:typecheck`: passed, including no explicit TypeScript `any` usage and workspace typechecks.
- `pnpm run verify:build`: passed.
- `pnpm run verify:test`: passed across non-database workspace tests.
- `git diff --check`: passed.
- Browser verification used the local sandbox at `http://localhost:9652/catalog/source-observations` with imported TCGdex set `basep`.

## Documentation To Promote

- Completed: Updated `bounded-contexts/catalog/docs/source-observation-integration.md` with explicit selected-row bulk promotion policy.
- Update Catalog README/GLOSSARY only if new durable terms are introduced. Current terms are sufficient if the feature uses "Bulk Promote" as an action label rather than a new domain concept.
- No ADR expected unless the decision shifts to promoting all filtered rows or auto-promoting observations after import.

## Goal Completion Criteria

- Implementation remains inside this worktree and branch.
- Product code changes stay in Catalog-owned source-observations behavior/UI/tests, with deployables only receiving generated or composition-root changes if required.
- Durable docs are promoted in the owning Catalog docs.
- Automated checks include focused Catalog tests, structure/localization/typecheck coverage appropriate to the change, and `git diff --check`.
- Desktop and mobile browser verification covers the updated Source Observations screen, including bulk selection and promotion result states.
- Submit a PR, get CI passing, merge, verify staging deploy, and retain this plan with the implementation.
