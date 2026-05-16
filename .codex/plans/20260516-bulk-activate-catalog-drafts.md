# Bulk Activate Catalog Drafts

## Intent

Improve the Catalog admin workflow for publishing many draft Catalog Items created by an integration, so operators can move hundreds of valid drafts to active without opening each Catalog Item detail page.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-bulk-activate-catalog-drafts`
- Branch: `codex/bulk-activate-catalog-drafts`
- Base: source repo `main` at `8cc4f1e6`
- Sandbox id: `88ddd5bc`
- Dependency setup: `pnpm run deps:install` completed successfully.
- Sandbox check: `pnpm run sandbox:doctor` completed successfully.
- Local ports: Admin web `http://localhost:8602`, Platform API `http://localhost:8612`.
- Setup caveats: pnpm reported existing cyclic workspace dependencies among Checkout, Ordering, Discovery, and marketplace seed testing; this appears pre-existing and did not block setup.

## Owning Contexts

- Catalog is the behavior owner. The context map states Catalog owns the canonical product model and Catalog owns Catalog Item identity, state transitions, read models, UI, routes, and tests.
- Catalog `catalog-items` is the likely implementation slice because `bounded-contexts/catalog/context.json` declares the admin Catalog Items route and the `catalog-items` slice.
- Downstream contexts such as Discovery, Inventory, Checkout, and Marketplace consume published Catalog Item facts. They should not own the operator activation workflow.

## Resolved Decisions

- Use the Catalog ubiquitous term `Catalog Item` in formal code, API, docs, and tests. UI may use `Item` only where the Catalog Items page makes the context unambiguous.
- Treat activation as the existing Catalog Item lifecycle command `PublishCatalogItem`, which changes status from `draft` to `active` by emitting `catalog.catalog-item.published`.
- Keep product implementation inside `bounded-contexts/catalog/features/catalog-items` plus Catalog-owned support modules when existing generic list composition needs small, explicit extension.
- Reuse the design system for row selection and bulk action UI. `DataTable` already supports `selectedKeys` and `onSelectionChange`, and `BulkActionBar` is exported for data-heavy admin screens.
- V1 bulk publish must support both explicit row selection and an explicit "all matching filtered drafts" path. The filter-wide path must require preview and confirmation so operators can safely publish hundreds of integration-created drafts without page-by-page repetition.
- Bulk publish uses partial-success semantics: publish valid draft Catalog Items and return actionable failed/skipped rows for invalid or stale items.
- Bulk publish validation should be derived inside Catalog. The current single-item publish API accepts `blueprintIsActive` and `requiredFieldIds` from the client, but a bulk workflow should compute active blueprint state and required field IDs from Catalog read models before dispatching the existing aggregate command.
- The list workflow must add a Catalog-owned source/integration filter based on external product references, so "all matching filtered drafts" can target imported records without sweeping unrelated hand-authored drafts.
- Filter-wide preview must resolve to an exact Catalog Item ID set. Confirmation publishes those previewed IDs, not a freshly re-evaluated filter, while still reporting rows that became stale or invalid between preview and publish.
- No product code, schema, tests, or runtime files are changed during this planning workflow.

## Repo Evidence

- `bounded-contexts/README.md`: Catalog owns the canonical product model and upstream Catalog facts.
- `bounded-contexts/catalog/README.md`: Catalog Item commands include `PublishCatalogItem`; Catalog Item owns the canonical parent item.
- `bounded-contexts/catalog/GLOSSARY.md`: Catalog Item is the canonical parent definition; avoid ambiguous `item_id`.
- `bounded-contexts/catalog/features/catalog-items/domain/domain.ts`: publish currently requires draft status, a blueprint, active blueprint confirmation, and required fields before emitting `catalog.catalog-item.published`.
- `bounded-contexts/catalog/features/catalog-items/api/route.ts`: current API only exposes `POST /api/catalog/items/:id/publish`.
- `bounded-contexts/catalog/features/blueprints/read-model/schema.ts`: Blueprint read models store `status` and `field_rules`, which can provide server-side publish validation inputs.
- `bounded-contexts/catalog/features/catalog-items/ui/catalog-item-detail-page.tsx`: the current publish action lives on the detail page, including a publish dialog.
- `bounded-contexts/catalog/features/catalog-items/ui/catalog-item-list-page.tsx`: the list has search, status, language filters, and view links, but no bulk action.
- `bounded-contexts/catalog/features/catalog-items/read-model/schema.ts`: Catalog Item read models store external product references in a separate table and detail projection, but the list contract does not currently expose provider/source targeting.
- `bounded-contexts/catalog/support/shell-support/ui/entity-list-page.tsx`: the generic list page wraps `DataTable` without selection props today.
- `packages/design-system/src/components/data-display/data-table.tsx`: `DataTable` has built-in selectable row support.
- `packages/design-system/src/components/data-display/filter.tsx`: `BulkActionBar` is available for selected-record actions.
- `bounded-contexts/catalog/support/shell-support/list-query-state.ts`: Catalog list pages are paged at 50 rows, which makes page-by-page selection feasible but not enough by itself for hundreds of drafts.

## Open Questions

- None.

## Implementation Checklist

- [x] Add a Catalog-owned bulk publish API for Catalog Items.
- [x] Decide request shape scope: support explicit IDs and a filter query snapshot for "all matching filtered drafts".
- [x] Add source targeting scope: expose a provider/source filter from external product references for integration-created draft batches.
- [x] Decide preview/confirm semantics: preview returns exact IDs; confirm publishes the previewed IDs.
- [x] Reuse the existing `PublishCatalogItem` command per Catalog Item so the aggregate invariants and `catalog.catalog-item.published` event remain canonical.
- [x] Return a bulk result with published count, skipped count, failed item summaries, and enough detail for operators to resolve invalid drafts.
- [x] Add list-page row selection and a `BulkActionBar` on Catalog Items.
- [x] If filter-wide selection is accepted, add a clear "all matching draft items" confirmation path that includes filter criteria and total count.
- [x] Add an integration/source filter to the Catalog Items list.
- [x] Keep filter-wide bulk publish draft-only and require an explicit confirmation dialog that names the source filter, count, and partial-success behavior.
- [x] Keep the single-item detail publish workflow available.
- [x] Add focused domain/API/UI tests for bulk publish success, partial failure, stale/non-draft rows, required-field failures, empty selection, and paging/filter behavior.
- [x] Run targeted Catalog tests and design-system/UI tests.
- [x] Verify the Catalog Items workflow visually on desktop and mobile against the admin web sandbox.

## Implementation Notes

- Added `POST /api/catalog/items/bulk-publish/preview` and `POST /api/catalog/items/bulk-publish/confirm`.
- Preview supports explicit IDs and a draft-only filter snapshot, resolves filter selections to exact Catalog Item IDs, and returns ready/blocked row detail.
- Confirmation accepts the previewed IDs and dispatches the existing `PublishCatalogItem` command for each ready Catalog Item.
- Bulk publish is partial-success: invalid, missing, stale, or non-draft Catalog Items are skipped or failed with row-level reasons while valid drafts publish.
- Catalog now exposes a source provider filter from `catalog_external_product_references`, so integration-created drafts can be targeted by provider.
- The Catalog Items list now has a Source column/filter, row selection, selected-row preview action, and filter-wide `Preview Filtered Drafts` action when Status is Draft.
- Added a Catalog-owned durable doc at `bounded-contexts/catalog/docs/bulk-catalog-item-publish.md` and linked it from `docs/README.md`.

## Verification Completed

- `pnpm --filter @chase-sets/catalog test`
- `pnpm --filter @chase-sets/catalog test` with `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:8620/postgres`
- `pnpm run check:localization`
- `pnpm run verify:typecheck`
- Admin web sandbox visual check at `http://localhost:8602/catalog/catalog-items?status=draft&source=tcgplayer` on desktop and mobile viewport.

## Documentation To Promote

- Consider a Catalog-owned note under `bounded-contexts/catalog/docs/` only if implementation introduces a durable bulk authoring policy or operator safety model beyond obvious UI behavior.
- Update `docs/README.md` only if a durable Catalog doc is added and belongs in the curated docs map.
- No ADR expected unless the implementation introduces a hard-to-reverse server-side bulk operation contract with surprising trade-offs.

## Stress Tests

- Normal flow: an operator filters Catalog Items to `draft`, selects all matching integration-created drafts, previews, confirms, and receives a success count.
- Partial flow: some selected drafts publish while invalid drafts return actionable failures without blocking valid items unless the final decision chooses all-or-nothing semantics.
- Stale data: a draft becomes active, archived, or invalid between preview and confirm; the API reports it as skipped or failed and does not duplicate events.
- Replay: repeated confirmation does not republish active items; existing aggregate invariant rejects non-draft publish attempts and bulk result reports stable outcomes.
- Cross-context handoff: downstream contexts continue to consume existing Catalog published facts; no downstream context receives a command-like event.
- Failure/cancellation: operator can cancel before confirm; network/API failure leaves already-published items visible in the result or recoverable by refresh.
- Low-value card economics: reducing per-item admin labor is essential when integrations create many low-margin card Catalog Items.

## Goal Completion Criteria

The implementation goal must:

- Implement this plan in `D:\Users\ToddS\Source\Repos\chase-sets-20260516-bulk-activate-catalog-drafts` on branch `codex/bulk-activate-catalog-drafts`.
- Retain `.codex/plans/20260516-bulk-activate-catalog-drafts.md` with updated decisions.
- Promote any durable Catalog docs that become necessary.
- Verify aggregate invariants, API behavior, read model behavior, and UI interaction with automated tests.
- Run mobile and desktop visual checks for the Catalog Items bulk publish workflow in the admin web sandbox.
- Submit a PR, get CI passing, merge the PR, and verify staging deploy behavior.
