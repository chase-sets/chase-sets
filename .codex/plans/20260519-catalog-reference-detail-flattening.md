# Catalog Reference Detail Flattening

## Intent

Meet the target state for TCGDex and Catalog reference data display:

- Catalog item detail labels resolve to natural labels such as Expansion, Series, Manufacturer, Card Illustrator, and Release Year.
- Reference-shaped field values display as concise label/value facts.
- Clicking a reference value exposes the selected Reference Record's additional information.
- Related Reference Records are promoted into their own base detail rows, so a selected Expansion also shows Series, Product Line, and Manufacturer as separate clickable values.
- Reference traversal must avoid circular display and should behave as a bounded tree for presentation even if stored relationships are graph-shaped.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260519-catalog-reference-detail-flattening`
- Branch: `codex/catalog-reference-detail-flattening`
- Sandbox id: `7bf4d8a8`
- Dependency setup status: installed with `node ./scripts/worktree-deps.mjs install`; `pnpm run sandbox:doctor` passed
- pnpm store path: default `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Catalog owns canonical Fields, Reference Types, Reference Records, source observation promotion, and the admin catalog item detail read model.
- Discovery owns public marketplace Detail Page presentation and can reshape projected Catalog facts for browse/detail display.
- The deployables remain thin composition roots; changes should stay in `bounded-contexts/catalog` and `bounded-contexts/discovery`.

## Repo Evidence

- Catalog docs already define the rich reference model: Reference Records may form `Expansion -> Series -> TCG/Product Line -> Manufacturer`, and Catalog Items should select the most specific record while inheriting broader facts.
- TCGDex promotion already sets the Catalog Item `Expansion` field as `{ referenceId }` and ensures Reference Types and Reference Records for Manufacturer, Product Line, Series, and Expansion.
- Catalog admin item detail projection and Discovery item detail projection both expand nested Reference Records with a maximum depth and path check.
- Discovery search acceptance tests already prove hierarchical reference records are indexed for search, facets, and item detail payloads.
- Both public Discovery item detail UI and Catalog admin item detail UI currently stringify reference attributes and relationships into one long value, which is the behavior shown in the screenshots.
- Field labels fall back to raw field ids when the field projection row is missing. A stale or partial local seed can therefore show `fld_seed_expansion`; the seed itself names that field `Expansion`.
- `seedCatalogDatabase` skips seeding when any dimensions exist, so existing partial sandbox data can miss newer Fields or Reference Data.
- Reference Data domain normalizes and deduplicates relationships, but does not reject cycles at write time. Projection traversal prevents infinite expansion, but authoring can still create circular graphs.

## Resolved Decisions

- Preserve Catalog as the behavior owner for Reference Records and relationship validity.
- Preserve Discovery as the behavior owner for public detail presentation.
- Do not duplicate reference attributes onto Catalog Item field values.
- Treat the direct field selection as the root display fact. For example, Expansion is the field row; Series, Product Line, and Manufacturer are inherited reference rows.
- Build presentation rows from the expanded reference graph with visited-reference protection and a depth cap.
- Display reference attributes in a click-revealed helper surface rather than inline on the row.
- Use a helper dialog as the canonical click surface for reference values, because it keeps users on the item page and works across public Discovery and Catalog admin detail views.
- Use Reference Type or type key as the inherited row label. Prefer a display name when available; otherwise title-case the type key.
- Keep relationship type out of the main row label unless multiple related records of the same type would otherwise collide.
- Add tests at both read/presentation boundaries: projected payload shape and rendered UI behavior.
- Repair seed/projection behavior as operational hygiene only if local or test setup proves labels are stale; do not make seed replay destructive.

## Open Questions

None.

## Implementation Checklist

- [x] Add or reuse a Discovery item-detail helper that converts `FieldValue[]` into flattened detail rows:
  - Direct field row: field label, reference name/simple value, optional reference detail payload.
  - Inherited reference rows: type label, reference name, optional reference detail payload.
  - Deduplicate by `referenceId`, retain direct field rows first, then traverse relationships in stable order.
  - Stop traversal on visited references and at the existing max depth.
- [x] Update Discovery item detail UI to render reference values as buttons or design-system interactive controls with an accessible detail dialog/panel.
- [x] Update Catalog admin item detail UI similarly, or introduce a catalog-local helper if the display requirements differ from public Discovery.
- [x] Add localization entries for reference detail surface labels such as Attributes, Relationships, Status, and Close if existing keys cannot be reused cleanly.
- [x] Add tests for:
  - Flattened rows show Expansion, Series, Product Line, Manufacturer separately.
  - Reference value click exposes attributes and relationships.
  - Circular relationships do not duplicate forever or crash.
  - Missing field projection labels continue to fall back predictably, while seeded fields resolve to natural labels after projection.
- [ ] Consider a Catalog Reference Data domain validation enhancement to reject self references immediately and reject simple cycles where reachable from currently projected reference records.
- [x] Run focused tests first, then broader catalog/discovery test suites.

## Verification Notes

- `pnpm --filter @chase-sets/catalog test -- features/catalog-items/ui/reference-detail-rows.test.ts features/catalog-items/ui/catalog-item-detail-page.test.tsx` passed.
- `pnpm --filter @chase-sets/discovery test -- features/item-detail/ui/reference-detail-rows.test.ts tests/item-detail-commerce-panel.test.tsx` passed.
- `pnpm run check:localization` passed.
- `pnpm run verify:typecheck` passed.
- `pnpm run verify:static` passed.
- `pnpm run verify:test` passed.
- `pnpm run verify:build` passed.
- Admin detail visually verified at `http://localhost:7002/catalog/catalog-items/cat_seed_bulbasaur_base_set`.
- Public detail visually verified at `http://localhost:7043/items/bulbasaur-base-set-44-102-common-seed-bulbasaur-base-set-ok08ju` because the sandbox's default marketplace port `7003` was already occupied by another worktree.
- Visual verification confirmed natural labels, flattened inherited reference rows, and reference helper dialogs exposing attributes and relationships.

## Documentation To Promote

- Update `bounded-contexts/catalog/docs/source-observation-integration.md` only if implementation changes the TCGDex reference hierarchy or operational seed/replay guidance.
- Update `bounded-contexts/discovery/GLOSSARY.md` only if a new Discovery term is introduced. Prefer not to introduce one.

## Goal Completion Criteria

- Target state implemented in the worktree.
- Focused tests pass for Catalog reference data, Catalog item detail, and Discovery item detail.
- Public item detail and admin item detail visually verified.
- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
