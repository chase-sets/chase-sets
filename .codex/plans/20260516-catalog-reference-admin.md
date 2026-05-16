# Catalog Reference Admin

## Intent

Make rich Catalog references usable from Catalog Admin. Admin users should be able to create, edit, publish, deprecate, archive, search, and inspect Reference Types and Reference Records, then tie Catalog Item field values to Reference Records without hand-writing reference-shaped JSON.

This plan now also covers hierarchical reference data consumption. A Catalog Item should only carry item-specific facts such as HP, attacks, card number, and printed name. Broader reusable facts should be attached once through Reference Records: for example, an Expansion Reference Record points to its Series Reference Record, and that Series points to a TCG/Product Line and Manufacturer Reference Record. Catalog item detail, Discovery detail, search text, and dynamic filters should consume that expanded hierarchy without duplicating facts onto each item.

The target experience should make common card catalog workflows natural:

- Create a `Set` Reference Type with attributes such as `card_count`, `release_date`, `abbr`, and `external_id`.
- Create a `Series` Reference Type.
- Create `Mega Evolution` as a Series Reference Record.
- Create `Ascended Heroes` as a Set Reference Record with attributes and a relationship to `Mega Evolution`.
- Set a Catalog Item's Set field by choosing `Ascended Heroes`, so item details show the enriched set facts and relationship.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-catalog-reference-admin`
- Branch: `codex/catalog-reference-admin`
- Sandbox id: `1fae4a39`
- Dependency setup: `pnpm run deps:install` passed.
- Sandbox doctor: passed.
- Admin web: `http://localhost:9252`
- Platform API: `http://localhost:9262`
- Test database: `postgresql://postgres:postgres@localhost:9270/postgres`
- Setup caveats: pnpm reported existing cyclic workspace dependencies among checkout, ordering, marketplace-seed-testing, and discovery; install succeeded.

## Owning Contexts

Resolved owner: Catalog.

Repo evidence:

- `bounded-contexts/README.md` names Catalog as the canonical product model owner.
- `bounded-contexts/catalog/README.md` says Catalog owns Reference Types and Reference Records that provide rich reusable facts for item fields.
- `bounded-contexts/catalog/GLOSSARY.md` defines Reference Type and Reference Record.
- `bounded-contexts/catalog/context.json` already includes `reference-data` as a Catalog slice and `reference-type` / `reference-record` as owned nouns.
- Existing Reference Data domain, read-model, runtime, and API modules live under `bounded-contexts/catalog/features/reference-data`.

Non-owner consumers:

- Discovery may later project curated reference facts for public browse/detail pages.
- Inventory, Marketplace, and Pricing should continue consuming stable Catalog Item/Product facts rather than owning reference authoring behavior.

Discovery is also in scope as a downstream projection consumer for this pass because it owns search, facets, and item detail presentation. Catalog remains the source of truth for Reference Records; Discovery only keeps denormalized read models for browse/search efficiency.

## Resolved Decisions

1. Keep Reference Type and Reference Record management inside the existing `reference-data` Catalog slice.
2. Add Catalog Admin route contributions and primary nav for rich references rather than managing them through deployable-local routes.
3. Follow existing Catalog Admin list/detail patterns: `EntityListPage`, `EntityDetailPage`, `LifecycleControls`, `DataTable`, `Dialog`, `TextInput`, and `Select`.
4. Preserve lifecycle semantics already in the domain: `draft -> active -> deprecated -> archived` for both Reference Types and Reference Records.
5. Keep Product identity unchanged. Reference management enriches descriptive item information only.
6. Store Reference Type attribute keys as normalized keys and Reference Record attributes/relationships as structured payloads through existing commands.
7. Include the Catalog Item reference-record picker in this pass, so users can tie item fields to records without hand-writing reference-shaped JSON.
8. Support reference hierarchy as Reference Record relationships, not as nested item fields. The canonical low-entropy shape is `item field -> Reference Record -> relationships -> Reference Records`.
9. Expand reference hierarchies into item read models with cycle protection and bounded depth. Four levels is enough for realistic card hierarchy such as `Expansion -> Series -> TCG/Product Line -> Manufacturer` while preventing runaway graphs.
10. Discovery must project Catalog reference records and refresh dependent items when referenced records or ancestor records change.
11. Search and dynamic filters should use reference record names/keys/attributes/relationship labels, not raw `{ referenceId }` JSON. The stored field filter value should remain the stable `reference_record_id`, while the visible label should be the record name.
12. Blueprints and Components continue to apply Fields. They do not need special reference hierarchy rules because the `reference` Field value type plus Reference Record relationships carries reusable descriptive facts without affecting Product identity.

## Open Questions

None blocking for implementation.

## Implementation Checklist

- [x] Add Reference Data admin route contributions in `bounded-contexts/catalog/context.json`.
- [x] Add primary nav entry for Reference Data.
- [x] Add route modules for reference type list/detail and reference record list/detail.
- [x] Add Reference Data UI contracts.
- [x] Add Reference Data client methods in Catalog API client and hook helpers.
- [x] Build Reference Type list/detail pages with create, edit, publish, deprecate, and archive.
- [x] Build Reference Record list/detail pages with create, edit, publish, deprecate, archive, attributes editing, and relationships editing.
- [x] Add searchable/filterable list controls for Reference Records, including type filtering where supported by the API.
- [x] Update Catalog Item field editing to offer a reference-record picker for `reference` fields.
- [x] Add focused UI/API tests for reference admin behavior and item field picker behavior.
- [x] Update Catalog docs if UI workflow guidance needs to be durable. No durable docs were needed because this adds admin affordances for existing Catalog policy.
- [x] Run structure, TypeScript, localization, no-any, Catalog tests, and browser visual checks on desktop/mobile admin surfaces.
- [x] Add bounded-depth hierarchical Reference Record expansion to Catalog item detail read models.
- [x] Make Reference Data admin relationship editing use record pickers instead of raw reference-record IDs.
- [x] Project Reference Records into Discovery search and item-detail read models.
- [x] Refresh Discovery search/detail items when direct or ancestor Reference Records change.
- [x] Use expanded reference names, keys, attributes, and relationship labels in Discovery search text and dynamic field facets.
- [x] Add Catalog and Discovery acceptance coverage for `Expansion -> Series -> TCG/Product Line -> Manufacturer` enrichment.
- [ ] Re-run automated checks, update PR #129, and track CI.

## Verification Notes

- `pnpm --filter @chase-sets/catalog test` passed.
- `$env:TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:9270/postgres'; pnpm --filter @chase-sets/catalog test` passed.
- `pnpm exec tsc -p tsconfig.json --noEmit` passed.
- `pnpm run check:structure` passed.
- `pnpm run check:no-any` passed.
- `pnpm run check:localization` passed.
- `pnpm --filter @chase-sets/discovery test` passed.
- `$env:TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:9270/postgres'; pnpm --filter @chase-sets/discovery test` passed.
- Hierarchical reference scenario covered in Discovery acceptance: `Expansion -> Series -> TCG -> Manufacturer`, search by ancestor reference names, direct and related reference facets, detail-page nested reference expansion, and ancestor rename refresh.
- `pnpm run sync:workspace-metadata --check` passed.
- Visual checks were captured with authenticated Chrome headless screenshots at:
  - `artifacts/visual-reference-admin/reference-records-desktop.png`
  - `artifacts/visual-reference-admin/reference-records-mobile.png`
  - `artifacts/visual-reference-admin/catalog-item-reference-picker-dialog.png`
- The worktree sandbox port `9270` was already occupied by an older sandbox, so visual checks used this worktree's admin web on `9252` pointed at this worktree's platform API on `9362` backed by the existing rich-reference sandbox database on `7720`.

## Documentation To Promote

- `bounded-contexts/catalog/README.md`: document bounded-depth reference hierarchy expansion and the rule that reusable descriptive facts belong on Reference Records.
- `bounded-contexts/catalog/GLOSSARY.md`: clarify that Reference Record relationships may form a hierarchy.
- `bounded-contexts/discovery/docs/dynamic-search-filters.md`: clarify how reference Field filters use stable Reference Record IDs with human-readable labels.
- `docs/GLOSSARY.md`: no cross-context term changes expected.

## Goal Completion Criteria

The implementation goal must:

- Implement the admin experience in this worktree and branch.
- Retain and commit this plan with the implementation.
- Promote durable Catalog docs for any new authoring policy.
- Verify automated checks for touched Catalog UI/API slices.
- Verify the Catalog Admin Reference Data and Catalog Item field-value picker surfaces on desktop and mobile where applicable.
- Submit a PR, track CI, merge, verify staging deployment, and note production deployment status if the merge reaches `main`.

Goal tool status: unavailable for a second goal in this thread. Exact intended goal:

> Implement the Catalog Reference Admin experience in worktree `D:\Users\ToddS\Source\Repos\chase-sets-20260516-catalog-reference-admin` on branch `codex/catalog-reference-admin` using plan `.codex/plans/20260516-catalog-reference-admin.md`. Add Reference Data admin management, a Catalog Item reference-record picker, durable docs if policy changes, automated checks, desktop/mobile visual verification, PR submission, CI tracking, PR merge, staging deploy verification, and note production deploy status if main advances through production.
