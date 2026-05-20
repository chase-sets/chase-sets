# Rich Reference Filtering

## Intent

Make buyer-facing Discovery search filtering use Catalog rich reference data so Pokemon Trading Card buyers can narrow results quickly by Expansion, Series, and Product Line without knowing provider IDs or internal field structure.

This plan is intentionally scoped to planning only until the product/API decision below is resolved. Product code, runtime code, schemas, tests, and UI have not been edited.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-rich-reference-filtering`
- Branch: `codex/rich-reference-filtering`
- Sandbox id: `b590b077`
- Dependency setup status: `pnpm run deps:install` completed on 2026-05-20; `pnpm run sandbox:doctor` passed.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`.
- Setup blockers: none known.

## Owning Contexts

- Discovery owns Search query behavior, Filter State, Facets, facet presentation, and browse-oriented read models. Evidence: `bounded-contexts/discovery/README.md` says Discovery owns "Filter state and facet presentation" and "Search index rebuild and projection workflows"; `bounded-contexts/discovery/GLOSSARY.md` defines `Discovery Query`, `Facet`, `Filter`, and `Filter State`.
- Catalog owns Reference Types and Reference Records. Evidence: `bounded-contexts/catalog/README.md` says Catalog owns Reference Types and Reference Records that provide rich reusable facts for item fields; `bounded-contexts/catalog/GLOSSARY.md` defines `Reference Type` and `Reference Record` and explicitly names Expansion, Series, and Product Line.
- Discovery is allowed to project Catalog reference facts for browse. Evidence: `bounded-contexts/README.md` says Discovery depends on Catalog for canonical item, category, blueprint, and field facts used to build browse/search views; `bounded-contexts/discovery/context.json` subscribes `discovery-search-item-projection` to Catalog reference-record events and owns `discovery_search_catalog_reference_records`.

## Repo Evidence

- Existing architecture already intends dynamic reference facets. `bounded-contexts/discovery/docs/dynamic-search-filters.md` says Reference Field facets should use stable `reference_record_id` values and may expose derived related Reference Record facets such as filtering an Expansion field by its related Series.
- Search projection already builds derived reference filters. `bounded-contexts/discovery/features/search/read-model/projection.ts` uses `collectReferenceRecords(reference)` and emits one facet value for the direct field plus inherited values using ids shaped as `<fieldId>:<record.typeKey>`.
- Search API already parses those filter keys. `bounded-contexts/discovery/features/search/api/route.ts` reads any query parameter beginning with `field.` as a field filter, so `field.<field_id>:series=<reference_record_id>` is accepted.
- Search UI already renders dynamic facets generically. `bounded-contexts/discovery/features/search/ui/search-page.tsx` displays `data.facets` in desktop and mobile filter controls and writes selected dynamic filters back to URL-backed Filter State.
- Acceptance coverage exists for a related reference filter. `bounded-contexts/discovery/tests/acceptance/marketplace-search.test.ts` asserts that `field.<expansionFieldId>:series=<seriesReferenceId>` returns the expected item.
- Catalog seed data uses the canonical Pokemon language the user named. `bounded-contexts/catalog/features/reference-data/api/seed.ts` seeds Reference Types `manufacturer`, `product-line`, `series`, and `expansion`; Product Line is `Pokemon Trading Card Game`; Series records relate to Product Line; Expansion records relate to Series.
- There is a language mismatch risk. Current Discovery facet labels for inherited references are built as `${field name} ${titleized typeKey}`. That makes `Expansion Series` and `Expansion Product Line`, while item detail already formats inherited rows as `Series` and `Product Line` via `formatReferenceTypeLabel`.

## Resolved Decisions

- Behavior owner: Discovery should own the filter behavior and presentation because this is browse/search behavior, not Catalog truth.
- Source truth: Catalog remains the source for Reference Types, Reference Records, relationships, and Catalog Item field values.
- Stable published fact: Discovery should filter by stable Catalog `reference_record_id`, never by display labels, provider IDs, or localized names.
- Product identity: Expansion, Series, and Product Line remain descriptive Field/Reference facets. They must not affect `product_id`; Dimension filters continue to be the only search filters carried to item detail product selection.
- Compatibility: Existing `field.<field_id>=<reference_record_id>` and `field.<field_id>:<type_key>=<reference_record_id>` filters should keep working during the change because tests and docs already establish that URL contract.
- Facet shape: inherited rich references will become first-class Discovery filters by Reference Type, using clean buyer-facing labels such as `Product Line`, `Series`, and `Expansion` and durable URL keys shaped as `reference.<type_key>=<reference_record_id>`.

## Open Questions

None after resolving the Reference Type facet shape decision on 2026-05-20.

## Implementation Checklist

- [x] Derive safe Reference Type labels from `type_key` using a Discovery-local formatter while Reference Type events are not yet subscribed.
- [x] Extend Discovery search contracts with a `reference` facet kind while preserving current field/dimension clients.
- [x] Store reference filter values for direct and inherited Reference Records as Reference Type facets: `reference.expansion`, `reference.series`, `reference.product-line`.
- [x] Parse `reference.<type_key>=<reference_record_id>` in the API route and browser route state.
- [x] Apply reference filters in `searchDiscoveryItems` as OR within a Reference Type and AND across types, matching existing Filter State rules.
- [x] Keep existing `field.<field_id>` and `field.<field_id>:<type_key>` filters working as result-scope compatibility aliases.
- [x] Hide legacy field-derived reference facets from the buyer-facing facet list so users see first-class Reference Type filters.
- [x] Update desktop and mobile Search UI to render reference facets with labels `Product Line`, `Series`, and `Expansion`, using existing design-system facet components.
- [x] Add acceptance tests for Expansion, Series, and Product Line filters using Pokemon reference language.
- [x] Add UI tests for reference facets and reversible chips.
- [x] Update `bounded-contexts/discovery/docs/dynamic-search-filters.md` and `docs/api/marketplace-api.md` for the URL contract.

## Verification

- `pnpm run deps:install`: passed; existing cyclic workspace dependency warning remains.
- `pnpm run sandbox:doctor`: passed for sandbox `b590b077`.
- `pnpm exec vitest run --config ./tests/vitest.config.mjs features/search/read-model/queries.test.ts features/search/ui/search-page.test.tsx` from `bounded-contexts/discovery`: passed, 23 tests.
- `pnpm --filter @chase-sets/discovery run test`: passed, 113 tests; 4 DB tests skipped in the package-level run without `TEST_DATABASE_URL`.
- `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:8970/postgres pnpm exec vitest run --config ./tests/vitest.config.mjs tests/acceptance/marketplace-search.test.ts` from `bounded-contexts/discovery`: passed, 4 DB acceptance tests.
- `pnpm run check:localization`: passed.
- `pnpm run verify:typecheck`: passed.
- `pnpm run verify:metadata`: passed.
- `pnpm run check:structure`: passed.

## Pressure Tests

- Normal flow: A buyer searches Pokemon cards and sees Product Line, Series, and Expansion filters with stable counts and labels.
- Partial data: An item with an Expansion but missing a related Series still gets an Expansion filter; no broken Product Line facet is emitted.
- Stale data or replay: Reference Record revisions must refresh affected items by direct and related reference graph, as current projection already does.
- Cross-context handoff: Discovery projects Catalog reference facts but does not mutate Catalog or own Reference Records.
- Failure or cancellation: If a Reference Record is archived/deprecated, the projection should refresh or hide values according to the same active-result rules used for other facets.
- Low-value card economics: Faster filtering by Product Line, Series, and Expansion reduces buyer search time and helps surface many low-value singles where precise set-level browsing matters more than one-off title search.

## Documentation To Promote

- Update `bounded-contexts/discovery/docs/dynamic-search-filters.md` with the first-class Reference Type facet contract.
- Update `bounded-contexts/discovery/GLOSSARY.md` only if adding a new Discovery term such as `Reference Facet`; otherwise keep `Facet` and `Filter` sufficient.
- Update `docs/api/marketplace-api.md` or OpenAPI docs if public API query parameters change.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
