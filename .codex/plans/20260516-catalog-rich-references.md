# Catalog Rich References

## Intent

Catalog fields currently store descriptive values such as `Set Name` as literal data on the Catalog Item. That is too thin for concepts like a card set, product line, or series because those concepts have their own durable identity and metadata. The addition should let a Catalog Item hold a field value that references a Catalog-owned rich reference record, so the item detail can expose both the selected value and the referenced record's rich facts.

Example target model:

- Reference type: `Set`
- Reference record: `Ascended Heroes`
- Record attributes: card count `217`, release date `2026-01-30`, abbreviation `ASC`, external ID `me02.5`
- Record relationship: part of Series `Mega Evolution`
- Catalog Item field value: field `Set` points at the `Ascended Heroes` reference record

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-catalog-rich-references`
- Branch: `codex/catalog-rich-references`
- Sandbox id: `ce853e4a`
- Sandbox doctor: passed
- Dependency setup: `pnpm run deps:install` passed
- Setup caveats: pnpm reported existing cyclic workspace dependencies among checkout, ordering, marketplace-seed-testing, and discovery; no install failure.

## Owning Contexts

Resolved owner: Catalog.

Repo evidence:

- `bounded-contexts/README.md` defines Catalog as the owner of the canonical product model for what can be bought or sold.
- `bounded-contexts/catalog/README.md` says Catalog owns canonical Catalog Item identity, field values, category membership, and product schema snapshots.
- Existing field values live in `bounded-contexts/catalog/features/catalog-items`.
- Downstream contexts such as Discovery, Inventory, Marketplace, and Pricing already project Catalog Item and product schema facts from Catalog events instead of owning catalog truth.

Non-owner consumers:

- Discovery should eventually project rich references for browse/detail pages.
- Inventory, Marketplace, and Pricing should receive only the stable reference facts they need for workflows and valuation, not own the authoring model.

## Resolved Decisions

1. Add a Catalog-owned `Reference Type` and `Reference Record` model rather than encoding rich data in `Field` definitions or free-form item JSON.
2. Extend field values by convention to support reference-shaped values, with a `referenceId` pointing at a Catalog Reference Record.
3. Keep Product identity unchanged. Reference Records enrich descriptive item information; they do not create sellable Product variation unless a Blueprint separately models that variation through Dimensions and Options.
4. Project enriched reference data into Catalog Item detail read models so "total info" is assembled from item fields plus referenced facts.
5. Keep deployables thin; add the model under the Catalog bounded context and wire it through Catalog services/API/projections.
6. First build pass keeps authoring APIs for Reference Types and Reference Records and enriches the existing Catalog Item detail DTO/UI; dedicated reference-management admin pages can follow as their own UI slice.

## Open Questions

None blocking for the first implementation pass.

Non-blocking follow-up: decide whether public Discovery detail pages should show all rich reference facts or a curated subset per reference type.

## Implementation Checklist

- [x] Add Catalog IDs for reference types and reference records.
- [x] Add a `reference-data` Catalog slice with domain events, read model schema, projection, queries, runtime, and API routes.
- [x] Add the slice to Catalog schema composition, services, API mount, context manifest, and projectors.
- [x] Enrich Catalog Item detail field values when their value is a reference-shaped object.
- [x] Update Catalog item UI contracts and detail formatting so referenced records render by name while keeping rich data available in the DTO.
- [x] Add tests proving a Set reference carries card count, release date, abbreviation, source ID, and Series relationship into the item detail DTO.
- [x] Update Catalog glossary/docs with Reference Type and Reference Record terms.
- [x] Run focused Catalog tests and structure checks.
- [x] Browser-smoke the admin app at `http://localhost:7702`; it renders the Catalog Admin sign-in page.

## Verification

- `pnpm --filter @chase-sets/catalog test`
- `$env:TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:7720/postgres'; pnpm --filter @chase-sets/catalog test`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm run check:structure`
- `pnpm run check:no-any`
- `pnpm run check:localization`

## Documentation To Promote

- `bounded-contexts/catalog/GLOSSARY.md`: add `Reference Type` and `Reference Record`.
- `bounded-contexts/catalog/README.md`: add rich reference model guidance near Field/Catalog Item ownership.
- `docs/GLOSSARY.md`: add cross-context index entries only if downstream contexts consume the terms directly in this pass.

## Goal Completion Criteria

The implementation goal must:

- Implement the feature in this worktree and branch.
- Keep the plan file retained and committed with the implementation.
- Promote durable docs in Catalog-owned documentation.
- Verify automated checks for the touched Catalog slices.
- Verify the admin Catalog Item detail UI on desktop and mobile if UI behavior changes are visible.
- Submit a PR, get CI passing, merge it, deploy to staging, and confirm staging behavior before marking the goal complete.
