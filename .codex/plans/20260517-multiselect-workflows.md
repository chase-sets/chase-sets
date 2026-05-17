# Catalog Admin Multi-Select Workflows

## Intent

Improve the Catalog admin list screens for Dimensions, Fields, Components, Blueprints, Categories, Catalog Items, Reference Data, and Source Observations so operators can find the right records quickly, select records across the common work scopes, and execute bulk actions that match the actions available on individual records.

The change should make high-volume authoring faster without moving Catalog behavior out of Catalog. Catalog remains the owner of lifecycle decisions and provider Source Observation review. The admin deployable remains a thin composition root.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-multiselect-workflows`
- Branch: `codex/multiselect-workflows`
- Sandbox id: `80f54be4`
- Dependency setup status: `pnpm run deps:install` completed successfully on 2026-05-17.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox doctor: `pnpm run sandbox:doctor` completed successfully on 2026-05-17.
- Setup blockers: none found.

## Owning Contexts

- Primary owner: `bounded-contexts/catalog`
- Owning slices:
  - `features/dimensions`
  - `features/fields`
  - `features/components`
  - `features/blueprints`
  - `features/categories`
  - `features/catalog-items`
  - `features/reference-data`
  - `features/source-observations`
- Context-local shared UI owner: `support/shell-support`
- Context-local shared read-model/query owner: `support/projection-support`
- Design-system owner for reusable table, filter, and bulk action primitives: `packages/design-system`
- Deployable impact: `deployables/admin-web` should only consume generated Catalog routes and shell contributions; no Catalog behavior should move into the deployable.

## Review Findings

- Catalog owns the requested terms and screens. `bounded-contexts/catalog/context.json` lists `blueprints`, `catalog-items`, `categories`, `components`, `dimensions`, `fields`, `reference-data`, and `source-observations` as Catalog slices and contributes the corresponding admin routes.
- `EntityListPage` already centralizes search, status filtering, pagination, `DataTable`, and optional selected keys, but most list pages do not opt into selection or bulk actions.
- `DataTable` supports page-local checkbox selection. It has no indeterminate select-all state, no "select all matching filters" concept, no disabled-selection explanation, and no bulk action menu.
- `BulkActionBar` exists in the design system and is already used by Catalog Items and Source Observations. The current use is narrow and inconsistent.
- Shared list query state supports `search`, `status`, `language`, `source`, `setId`, `typeKey`, and pagination. It does not yet support common Catalog admin filters such as value kind, value type, blueprint, parent category, tag, provider, or selected bulk scope encoding.
- Most authoring slices support only per-record lifecycle endpoints:
  - Dimensions: activate, deprecate, archive.
  - Fields: activate, deprecate, archive.
  - Components: activate, deprecate, archive.
  - Blueprints: publish, deprecate, archive.
  - Categories: publish, deprecate, archive.
  - Reference Types: publish, deprecate, archive.
  - Reference Records: publish, deprecate, archive.
  - Catalog Items: publish, retire, archive, plus many detail-scoped editing actions.
  - Source Observations: promote, reject, plus import and scope promotion.
- Existing bulk behavior:
  - Catalog Items can preview and confirm publish for explicit ids or filtered drafts.
  - Source Observations can promote selected observed rows and preview/confirm promotion for all matching filters.
- Search behavior is uneven:
  - Common authoring lists search `key` and `name`.
  - Catalog Items search `title` and `subtitle` only.
  - Source Observations search external key, source URL, set id, name, and expansion/set name.
  - Reference Records search `key` and `name`, with a single `typeKey` filter.
- The glossary says Catalog does not own Discovery multi-select filtering behavior. This task is Catalog admin authoring/search workflow behavior, so it stays in Catalog.

## Resolved Decisions

- Treat "Reference Data" as both Reference Types and Reference Records because both are Catalog reference-data screens and both expose per-item lifecycle actions.
- Add reusable selection and bulk workflow support in `bounded-contexts/catalog/support/shell-support` when it is Catalog-admin specific; use `packages/design-system` only for generic primitives that are not Catalog-specific.
- Model bulk action requests as either explicit ids or a server-resolved filter scope. Do not trust the client to page through all ids for "all matching" operations.
- Every bulk operation must return per-record outcomes, including succeeded, skipped, failed, and reason, because mixed-status selections are normal in list workflows.
- Bulk lifecycle actions should reuse existing aggregate commands per record instead of adding new bulk domain commands that bypass invariants.
- Bulk actions must be status-aware. Invalid records should be excluded or skipped with an explicit reason, not silently mutated.
- Selection must reset or reconcile when filters, page, or eligibility changes so stale selected ids do not trigger surprising actions.
- UI must use existing design-system components and localization keys; no custom UI overrides in Catalog list pages.
- Bulk action coverage for this pass includes lifecycle actions everywhere plus shared low-risk edits where one input safely applies to every selected record. It explicitly excludes complex nested editors such as Dimension option editing, Component rule editing, Blueprint structural rules, Catalog Item field values, image fallback editing, and external product reference editing.

## Resolved Questions

### Bulk Detail Action Coverage

Decision: Should "all actions available on a per item basis" include only lifecycle actions visible in each list row/detail header, or should it include every detail-page edit operation that can be meaningfully applied to multiple records?

Answer: include lifecycle actions for every selected entity now, and include only low-risk shared edit operations where a single input can safely apply to all selected records, such as Catalog Item tags, categories, blueprint assignment, and Source Observation rejection reason. Defer complex nested edits such as Dimension option editing, Component rule editing, Blueprint structural rules, Catalog Item field values, image fallback, and external product references unless the user explicitly asks for those as separate bulk editors.

Repo evidence:
- Detail pages include many nested actions whose inputs are entity-specific, such as Dimension option edits, Component field/dimension rules, Blueprint field/dimension/product resolution rules, and Catalog Item field values.
- Domain invariants reject lifecycle transitions from the wrong status, and Catalog Item publish already needs a preview path because readiness depends on blueprint and field completeness.
- Existing bulk Catalog Item publish and Source Observation scope promote flows already use preview/confirm to avoid surprise partial changes.

Consequence of choosing differently:
- Full detail-action coverage in this pass requires bulk editors for heterogeneous nested structures and significantly expands validation, previews, API contracts, and tests. It is doable, but it should be treated as a broader Catalog authoring operations feature rather than a list multi-select uplift.

Status: resolved on 2026-05-17.

## Implementation Checklist

### Shared Catalog List Workflow

- Add a Catalog-admin selection model under `support/shell-support` that supports explicit ids, current page, eligible current page, and all matching filter scope.
- Add a reusable bulk action definition model with id, label, tone, icon, confirmation requirement, eligibility predicate, preview support, and executor hook.
- Update `EntityListPage` to render selection summary, clear selection, page selection, and "all matching" affordances consistently across screens.
- Update `EntityListPage` to place bulk actions in the existing design-system `BulkActionBar` and keep per-row "View" behavior intact.
- Update `DataTable` or compose around it to support indeterminate select-all, accessible labels, disabled row selection explanations, and selection on mobile card mode.
- Preserve pagination and search debouncing while ensuring filter changes clear or reconcile selection.
- Add localized copy for shared selection states, confirmation dialogs, partial-success results, skipped records, and all-matching scope labels.
- Add tests for selection persistence, filter reset, current-page select all, all-matching scope, disabled row selection, and mobile rendering where supported.

### Shared Bulk API Pattern

- Define a Catalog-local bulk selection contract for list operations:
  - `{ mode: "ids", ids: string[] }`
  - `{ mode: "filter", query: CatalogListQuery-compatible scope }`
- Define a shared bulk result shape with counts and per-record candidates/outcomes.
- Add context-local helpers for resolving filter scopes into ids per slice without leaking behavior into deployables.
- Add preview endpoints for destructive or partial lifecycle actions where status mismatch is common.
- Run each selected record through the existing command handler so event sourcing invariants remain authoritative.
- Drain/revalidate projections after bulk writes consistently with existing single-record behavior.
- Cap or stream very large bulk operations intentionally; document the first-pass limit if needed.

### Search And Filter Coverage

- Dimensions:
  - Keep search across key/name and add value kind filter.
  - Add status-specific quick filters for draft, active, deprecated, archived.
  - Add bulk activate, deprecate, and archive.
- Fields:
  - Keep search across key/name and add value type filter.
  - Add filters for filterable, searchable, and sortable behavior.
  - Add bulk activate, deprecate, and archive.
- Components:
  - Keep search across key/name and add filters for has field rules, has dimension rules, and status.
  - Add bulk activate, deprecate, and archive.
- Blueprints:
  - Keep search across key/name and add filters for has components, has field rules, has dimension rules, and status.
  - Add bulk publish, deprecate, and archive with preview reasons for invalid publish readiness.
- Categories:
  - Keep search across key/name and add parent category filter.
  - Add root-only and child-category quick filters.
  - Add bulk publish, deprecate, and archive.
- Catalog Items:
  - Expand list filters to blueprint, tag, language, source provider, status, missing blueprint, missing required fields, has images, and has source references where practical.
  - Expand search to include tags and external provider keys/records if indexed/read-model feasible.
  - Generalize existing bulk publish preview/confirm into the shared bulk action surface.
  - Add bulk retire and archive.
  - Add safe shared bulk edit actions if approved: assign blueprint, assign/remove category, set/merge/clear tags.
- Reference Types:
  - Keep search across key/name and add attribute-key filter.
  - Add bulk publish, deprecate, and archive.
- Reference Records:
  - Keep search across key/name and keep type filter.
  - Add filters for relationship type, related reference record, attribute key/value if feasible.
  - Add bulk publish, deprecate, and archive.
- Source Observations:
  - Keep status, language, and set/expansion filters.
  - Add provider filter to the visible UI; the read model already supports provider scope.
  - Expand search to card number where needed because the table exposes card number.
  - Generalize selected and all-matching promote into shared bulk action surface.
  - Add bulk reject for observed records with a required shared reason if approved.

### Per-Slice API And Runtime Tasks

- Dimensions: add bulk lifecycle preview/confirm endpoints and UI client functions.
- Fields: add bulk lifecycle preview/confirm endpoints and UI client functions.
- Components: add bulk lifecycle preview/confirm endpoints and UI client functions.
- Blueprints: add bulk lifecycle preview/confirm endpoints and UI client functions.
- Categories: add bulk lifecycle preview/confirm endpoints and UI client functions.
- Catalog Items: extend existing bulk publish endpoints into the shared contract; add retire/archive endpoints; add approved shared-edit endpoints.
- Reference Data: add bulk lifecycle preview/confirm endpoints for Reference Types and Reference Records; decide whether one endpoint handles both nouns or each noun keeps a separate route.
- Source Observations: adapt existing bulk promote endpoints to the shared contract; add approved bulk reject endpoint.

### Read Models And Query Tasks

- Extend `CatalogListQuery` and `buildCatalogListApiQuery` for new filter keys without breaking existing routes.
- Add slice-specific query param parsing only where the slice owns the filter.
- Keep generic `ListParams` tiny; add typed slice params in each slice for specialized filters.
- Add SQL conditions through structured helpers instead of ad hoc string concatenation in UI.
- Add tests for each new filter and for filter-to-id resolution used by all-matching bulk operations.
- Pressure test all-matching filters against stale projections: preview should show counts from the current read model and confirm should resolve ids again or include a preview token/snapshot decision.

### UI Tasks

- Add selection state to Dimensions, Fields, Components, Blueprints, Categories, Reference Types, and Reference Records list pages.
- Replace Catalog Items and Source Observations bespoke bulk bars with the shared Catalog bulk action model.
- Add confirmation dialogs that show matched, eligible, skipped, and failed counts before destructive actions.
- Show per-record result tables for bulk actions, capped with a clear truncation message like the existing Catalog Item publish preview.
- Keep create/import actions separate from selection actions.
- Add "View" as a row-level action only; do not duplicate navigation in the bulk bar.
- Ensure filters are scannable and not a landing-page-style layout; the admin screens should stay dense and operational.
- Verify desktop and mobile behavior with the in-app browser after implementation.

### Tests And Verification

- Add/extend catalog UI tests for each affected list page.
- Add route/API tests for every new bulk endpoint and filter.
- Add read-model query tests for new filters and all-matching id resolution.
- Add domain tests only where a new domain decision is introduced; lifecycle bulk should mostly rely on existing aggregate tests.
- Add design-system tests if `DataTable`, `BulkActionBar`, or filter primitives change.
- Run targeted tests:
  - `pnpm --filter @chase-sets/catalog run test`
  - `pnpm run test:design-system` if design-system primitives change
  - `pnpm run check:localization`
  - `pnpm run typecheck`
- Run broader verification before PR:
  - `pnpm run verify`
- Start the admin sandbox and verify `http://localhost:11002` screens visually and interactively after implementation.

## Documentation To Promote

- Add or update a Catalog-owned doc if bulk operation contracts become non-obvious: `bounded-contexts/catalog/docs/admin-bulk-workflows.md`.
- Update `docs/README.md` if the new doc should appear in the curated docs map.
- Consider a small design-system note or tests around selection/bulk table patterns if `DataTable` behavior changes.
- No ADR is expected unless preview snapshot semantics become a hard-to-reverse architectural decision.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.

## Local Implementation Status

Completed locally in the implementation worktree:

- Added shared Catalog bulk lifecycle runtime support with preview/confirm outcomes, read-model scope resolution, stale/blocked row handling, and tests.
- Added shared Catalog bulk lifecycle UI for selected rows and matching filtered scope, including preview dialogs and per-record result tables.
- Added indeterminate select-all behavior to the design-system `DataTable`.
- Added multi-select and lifecycle actions to Dimensions, Fields, Components, Blueprints, Categories, Reference Types, Reference Records, and Catalog Items.
- Added safe shared Catalog Item bulk edits for assigning blueprints, assigning/removing categories, and setting/merging/clearing tags across selected or matching filtered records.
- Added selected and matching-scope bulk rejection for Source Observations with a required shared rejection reason.
- Expanded common workflow filters and query-state support across the affected screens, including value kind/type, field flags, component/blueprint rule presence, category hierarchy/parent, catalog item blueprint/tag/media/source-reference/required-field filters, reference data attribute/relationship filters, and visible Source Observation provider filtering.
- Expanded Catalog Item search to include tags and external references, and Source Observation search to include normalized card number.
- Added API client support, route/runtime endpoints, and localization for the new workflows.
- Added `bounded-contexts/catalog/docs/admin-bulk-workflows.md` and promoted it in `docs/README.md` to document preview/confirm, filtered-scope resolution, mixed-result semantics, lifecycle coverage, Catalog Item shared edits, and Source Observation rejection.

Verification completed locally:

- `pnpm --filter @chase-sets/catalog run test`
- `pnpm run check:localization`
- `pnpm run test:design-system`
- `pnpm run check:no-any`
- `pnpm exec tsc -p ./tsconfig.json --noEmit`
- `pnpm --filter @chase-sets/design-system run typecheck`
- `pnpm run verify:static`
- `pnpm run verify:test`
- `pnpm run verify:build`
- `pnpm run verify:typecheck`
- `pnpm run verify` was also attempted after the safe shared edit implementation, but the monolithic command exceeded the local 15-minute timeout before returning a complete result; the split verification gates above completed successfully afterward.
- Admin visual smoke checks at `http://localhost:11002` for Dimensions, Catalog Items, Source Observations, and Reference Records, with screenshots under `artifacts/visual-checks`.
- Additional Catalog Items bulk edit visual smoke check completed after the safe shared edit implementation; screenshot: `artifacts/visual-checks/catalog-items-bulk-edit.png`.

Known follow-up before goal completion:

- PR creation, remote CI verification, merge, staging verification, and production verification remain open goal criteria.
