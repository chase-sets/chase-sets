# Catalog External Reference Config Extraction

## Issue

- GitHub: #624 Make external Catalog Item and Product reference extraction config-driven
- Milestone: Catalog integration config/data-driven migration
- Label: integration:catalog-config-mapping

## Goal

Replace provider-specific external reference extraction with a Catalog-owned engine that interprets provider profile rules for Catalog Item-level and Product-level identifiers.

## Current State

- TCGdex marketplace Product IDs are extracted by handwritten functions in `tcgdex-client.ts`.
- TCGplayer Product IDs are manually attached as Catalog Item references in `tcgplayer-automation-catalog-client.ts`.
- TCGplayer SKU Product references are built by a separate selected-option helper and are not yet connected to a shared reference extraction engine.
- The provider profiles already describe provider key, target level, prefix, container keys, value keys, record id keys, pricing scope, and ambiguity policy.

## Implementation Plan

1. Add a generic external reference extractor for Catalog provider profile rules.
   - Interpret container keys, value keys, record id keys, provider key, target level, external key prefix, and pricing scope.
   - Normalize prefixes and de-dupe references by target/provider/external key.
   - Keep Catalog Item references and Product references as separate result collections.
   - Emit redaction-safe diagnostics/review evidence for missing, ambiguous, wrong-target, or unmapped identifiers.

2. Route TCGdex marketplace reference extraction through the generic extractor.
   - Preserve variant-specific pricing behavior and repeated-reference skip policy.
   - Preserve current tests for exact references and repeated marketplace IDs.

3. Route TCGplayer product/SKU extraction through the generic extractor.
   - Product IDs become only Catalog Item references.
   - SKU IDs become only Product references, and only after selected options validate.
   - Preserve review evidence for SKU condition, printing, language, and product form.

4. Add focused tests for #624 acceptance.
   - Exact match.
   - Missing value.
   - Repeated value ambiguity.
   - Wrong target level separation.
   - Future-provider evidence such as Scrydex/Scryfall `tcgplayer_id`.

## Verification

- `pnpm exec vitest run --config ./tests/vitest.config.mjs features/source-observations/api/provider-external-reference-extractor.test.ts features/source-observations/api/tcgdex-client.test.ts features/source-observations/api/tcgplayer-automation-catalog-client.test.ts` from `bounded-contexts/catalog`
- `pnpm --filter @chase-sets/catalog run test:unit`
- `pnpm run verify:typecheck`
- `pnpm run check:localization`
- `pnpm exec prettier --check ...`

## Rollback

Revert the PR. No schema changes are planned for this slice.
