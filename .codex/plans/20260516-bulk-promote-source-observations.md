# Bulk Promote Source Observations

## Intent

Improve the Catalog admin Source Observations screen so operators can promote many reviewed TCGdex observations in one workflow instead of opening each observation detail page and promoting records one at a time.

The implementation should preserve the review-first Catalog policy: provider data remains a Source Observation until a Catalog operator explicitly promotes it into draft Catalog Items. Bulk promotion should reduce repetitive clicks without turning TCGdex ingestion into automatic canonical truth.

2026-05-16 requirement update: the first completed slice only promotes explicitly selected observations on the current page. That works for page-scale review, but new set imports can contain hundreds of observations. After spot checking an imported set, operators need an efficient way to promote every eligible observation in the reviewed set/filter scope, not only the current page.

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
- Current planning pass: reusing this existing feature worktree because it clearly belongs to the source-observation bulk promotion request. The branch currently contains a committed first slice named `Add bulk source observation promotion`; origin tracking branch is gone.

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
- Superseded by the 2026-05-16 requirement update: selected-row promotion remains useful, but the workflow now also needs a promote-all operation that targets eligible observations beyond the current page.
- Accepted 2026-05-16: promote-all should target all eligible `observed` Source Observations matching the current reviewed filter/search scope, not only selected page rows, not hidden "last imported set" session state, and not every observed Source Observation globally.
- Filter-scoped promote-all must require explicit confirmation that summarizes the target scope and expected counts before executing.
- Use design-system table selection and `BulkActionBar` patterns instead of custom list controls.
- Add focused tests around partial success, terminal-state protection, UI selection behavior, and the bulk API/client contract.

## Repo Evidence

- `bounded-contexts/README.md` says Catalog owns canonical product truth and downstream contexts consume Catalog facts through stable IDs and events.
- `bounded-contexts/catalog/README.md` now lists Provider Source Observations as Catalog-owned and says promotion emits Catalog Item commands while Source Observations are not downstream truth until promoted.
- `bounded-contexts/catalog/GLOSSARY.md` defines Source Observation as a provider-sourced candidate record reviewed before it becomes Catalog truth.
- `bounded-contexts/catalog/context.json` includes `source-observations` as a Catalog slice and routes it into `admin-web` at `/source-observations`.
- `bounded-contexts/catalog/docs/source-observation-integration.md` states external providers never write canonical Catalog Items directly and operators promote or reject observations after review.
- `bounded-contexts/catalog/features/source-observations/api/runtime.ts` exposes `promoteObservation` for a single observation and creates a draft Catalog Item, assigns the Pokemon blueprint/category/fields/tags/images, links the TCGdex external reference, emits `catalog.source-observation.promoted`, and drains projectors.
- `bounded-contexts/catalog/features/source-observations/api/route.ts` exposes selected-ID `POST /bulk-promote`, plus `POST /:id/promote` and `POST /:id/reject`; there is no filter-scoped promote-all route or preview yet.
- `bounded-contexts/catalog/features/source-observations/ui/source-observation-list-page.tsx` now allows selected visible-row bulk promotion, but its selected IDs are derived from `data.items`, so select-all is page-scoped.
- `bounded-contexts/catalog/features/source-observations/ui/source-observation-detail-page.tsx` still supports single-record promotion and rejection.
- `bounded-contexts/catalog/features/source-observations/read-model/queries.ts` supports list filters for status, free-text search, provider, and language; it does not yet expose a reusable all-matching ID query or set-specific filter.
- TCGdex observations include normalized `setId`, `setName`, provider key, language code, and status, so the source-observations slice has enough owned data to define a server-side promote-all matching-scope operation.
- `packages/design-system/src/components/data-display/data-table.tsx` already supports `selectedKeys` and `onSelectionChange`.
- `packages/design-system/src/components/data-display/filter.tsx` already exports `BulkActionBar`, and `packages/design-system/README.md` names `DataTable`, `FilterBar`, and `BulkActionBar` as data-heavy admin screen primitives.

## Open Questions

- None for the next implementation slice.

## Settled Recommendation

Promote explicitly selected rows only for the first iteration.

Why it matters: promotion creates draft Catalog Items and external product mappings. That is intentionally reversible through draft review, but still creates canonical Catalog records. Explicit selection keeps operator intent visible and makes partial failures easier to understand.

Repo evidence: Source Observation policy requires operator review before promotion; the design system already supports selected table rows plus a bulk action bar; the current list page has server-side filters and pagination, so "all filtered rows" could silently affect records not visible on the current page.

Accepted answer: selected rows.

Consequence of choosing differently later: promoting all filtered rows would be faster for whole-set imports, but it would require stronger safeguards such as a confirmation summary, count-by-status preview, server-side filter snapshot, and probably conflict/dry-run reporting before executing.

## Next Recommendation

Add a second bulk action for all eligible observations matching the current list filters, with a confirmation preview before execution.

Why it matters: this matches the operator workflow for an imported set after spot checking while still preserving intentional review. It also avoids a dangerous global action and avoids relying on client-side pagination state.

Repo evidence: the list route already carries durable filters in the URL (`search`, `status`, and `language`), the read model can filter by provider/language/status/search, and each observation stores normalized TCGdex set fields. The current page-level selection is the limiting factor, not the promotion domain behavior.

Recommended answer: promote all `observed` Source Observations matching the current reviewed filter scope. Add a set/provider-aware filter if the current search box is too implicit for imported-set review, then require confirmation that shows the count to promote, skipped terminal count, and filter summary.

Consequence of choosing differently: "last imported set" is ergonomic but creates hidden session state unless persisted as an import batch concept; "all observed globally" is fastest but too broad for a review-first Catalog workflow and likely unsafe once multiple providers/languages/imports exist.

Accepted answer: current filters.

Implementation implication: add server-side query support to count and enumerate all matching `observed` Source Observations without applying list pagination, then add a preview/confirmation endpoint or mode so the UI can show the action scope before submitting the promotion command.

## Stress Tests

- Normal flow: operator imports a TCGdex set, filters to that set/language/status, spot-checks several rows across the first page, opens promote-all confirmation, sees the matching count, and promotes every eligible observation in that filter scope.
- Partial flow: some matching observations were already promoted or rejected after the preview; execution skips terminal observations and reports final promoted/skipped/failed counts.
- Stale data/replay: promotion remains event-sourced through the existing per-observation command path, so replay reconstructs terminal statuses from emitted Source Observation events.
- Cross-context handoff: Catalog creates draft Catalog Items and source mappings; Discovery/Pricing/Inventory consume only later Catalog facts and do not participate in provider review.
- Failure/cancellation: canceling the confirmation changes nothing; a mid-run failure reports per-observation outcomes and does not retry automatically.
- Low-value card economics: whole-set promotion reduces repetitive admin labor for many lower-value cards while keeping draft review before downstream sale workflows.

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
- Completed next slice: Added filter-scope query helpers in `bounded-contexts/catalog/features/source-observations/read-model/queries.ts` that apply the same filters as the list route but omit pagination for promote-all execution.
- Completed next slice: Extended the bulk promotion application service to accept either explicit IDs or a filter scope; per-observation promotion remains the only state-changing path.
- Completed next slice: Added `POST /source-observations/bulk-promote/preview` for confirmation counts and extended `POST /source-observations/bulk-promote` to execute an explicit filter scope.
- Completed next slice: Added UI affordance beside the filters for "Promote all matching" with a confirmation dialog showing count and filter summary.
- Completed next slice: Added a Source Observations `setId` list filter and set it automatically after TCGdex import, along with language and `observed` status.
- Completed next slice: Preserved main's shared `source` query filter during rebase and mapped it to Source Observation provider scope for listing and promote-all preview/execution.
- Completed next slice: Added localization keys for promote-all matching action, confirmation title/body, count summary, and completion/failure messaging.
- Completed next slice: Added focused tests for all-matching preview counts, execution through a filter scope, current filter propagation, UI confirmation behavior, and list-query `setId` support.
- Completed next slice: Re-ran focused Catalog tests, localization, structure, typecheck, build, non-database workspace tests, `git diff --check`, and desktop/mobile browser verification.

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
- `pnpm --filter @chase-sets/catalog exec vitest run features/source-observations/api/route.test.ts features/source-observations/read-model/queries.test.ts features/source-observations/ui/source-observation-list-page.test.tsx support/shell-support/list-query-state.test.tsx`: passed, 4 files and 12 tests.
- `pnpm --filter @chase-sets/catalog exec tsc --noEmit`: passed after adding `setId` to list controls.
- `pnpm --filter @chase-sets/catalog run test`: passed, 15 files passed and 1 skipped; 115 tests passed and 2 skipped.
- `pnpm run check:localization`: passed for 387 source files.
- `pnpm run check:structure`: passed.
- `pnpm run verify:typecheck`: passed, including no explicit TypeScript `any` usage and workspace typechecks.
- `pnpm run verify:test`: passed across non-database workspace tests.
- `pnpm run verify:build`: passed.
- `git diff --check`: passed.
- Desktop visual verification at `http://localhost:9652/catalog/source-observations?status=observed&language=en&setId=basep`: signed in as seeded demo user, verified Source Observations page, Set ID filter, Promote all matching action, and confirmation dialog showing `52 eligible observations will be promoted` with scope `status observed, language English, set basep`.
- Mobile visual verification at the same URL with 390x844 viewport: verified Promote all matching action opens the confirmation dialog, dialog text/buttons fit, and the confirmation remains usable above the mobile navigation.
- After rebasing onto `origin/main`, `pnpm --filter @chase-sets/catalog exec vitest run features/source-observations/api/route.test.ts features/source-observations/read-model/queries.test.ts features/source-observations/ui/source-observation-list-page.test.tsx support/shell-support/list-query-state.test.tsx`: passed, 4 files and 13 tests.
- After rebasing onto `origin/main`, `pnpm --filter @chase-sets/catalog exec tsc --noEmit`: passed.
- After rebasing onto `origin/main`, `pnpm --filter @chase-sets/catalog run test`: passed, 17 files passed and 1 skipped; 123 tests passed and 3 skipped.
- After rebasing onto `origin/main`, `pnpm run check:localization`: passed for 388 source files.
- After rebasing onto `origin/main`, `pnpm run check:structure`: passed.
- After rebasing onto `origin/main`, `pnpm run verify:typecheck`: passed, including no explicit TypeScript `any` usage and workspace typechecks.
- After rebasing onto `origin/main`, `pnpm run verify:test`: passed across non-database workspace tests.
- After rebasing onto `origin/main`, `pnpm run verify:build`: passed.
- After rebasing onto `origin/main`, `git diff --check`: passed.

## Documentation To Promote

- Completed: Updated `bounded-contexts/catalog/docs/source-observation-integration.md` with explicit selected-row bulk promotion policy.
- Completed: Updated `bounded-contexts/catalog/docs/source-observation-integration.md` with filter-scoped promote-all policy and confirmation requirement.
- Update Catalog README/GLOSSARY only if new durable terms are introduced. Current terms are sufficient if the feature uses "Bulk Promote" as an action label rather than a new domain concept.
- No ADR expected unless the decision shifts to promoting all filtered rows or auto-promoting observations after import.

## Goal Completion Criteria

- Implementation remains inside this worktree and branch.
- Product code changes stay in Catalog-owned source-observations behavior/UI/tests, with deployables only receiving generated or composition-root changes if required.
- Durable docs are promoted in the owning Catalog docs.
- Automated checks include focused Catalog tests, structure/localization/typecheck coverage appropriate to the change, and `git diff --check`.
- Desktop and mobile browser verification covers the updated Source Observations screen, including bulk selection and promotion result states.
- Submit a PR, get CI passing, merge, verify staging deploy, and retain this plan with the implementation.
