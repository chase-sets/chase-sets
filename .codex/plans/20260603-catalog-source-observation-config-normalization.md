# Catalog Source Observation Config Normalization

## Issue

- GitHub: #623 Make Source Observation normalization config-driven
- Milestone: Catalog integration config/data-driven migration
- Label: integration:catalog-config-mapping

## Goal

Replace provider-specific Source Observation shape construction with a Catalog-owned normalizer that executes mapping config from provider profiles while preserving the current TCGdex Pokemon card variant output and TCGplayer provider-product output.

## Current State

- `tcgdex-client.ts` fetches provider JSON and manually builds one `SourceObservationPokemonCardNormalized` per variant.
- `tcgplayer-automation-catalog-client.ts` manually builds one `SourceObservationProviderProductNormalized` per product detail.
- #622 added a selector/transform interpreter, but no wrapper turns a profile mapping contract into a full Source Observation record.
- Current event payloads have no first-class persisted diagnostics field, so this slice will expose redaction-safe diagnostics from normalization and fail before recording invalid required mappings. Persisted review diagnostics remain a later admin/review slice.

## Implementation Plan

1. Add a generic Source Observation normalizer in the Catalog Source Observations API.
   - Execute configured expressions for observation id, external key, source URL, language, source updated at, source payload retention, normalized fields, hash material, and merge identity.
   - Support `pokemon-card`, `provider-product`, and future extension-shaped normalized records through declared output kind plus field contracts.
   - Return typed output plus redaction-safe diagnostics from the interpreter.

2. Extend the executable mapping contract with Source Observation identity/retention mapping.
   - Keep transport-owned fetch/parsing separate from Catalog-owned normalization.
   - Prevent price, listing, seller, sale, inventory, and secret evidence from being used as Catalog truth or hash material.

3. Route current providers through the generic normalizer.
   - TCGdex keeps transport-specific set/card fetching and variant expansion, then passes a prepared provider payload plus profile mapping config to the normalizer.
   - TCGplayer keeps automation-client transport, then passes product detail payload plus profile mapping config to the normalizer.
   - Preserve current observation ids, external keys, source URLs, source payload retention, hashes, merge identity, image evidence, and normalized fields.

4. Add focused tests.
   - TCGdex fixture proves current Pokemon card variant output is produced by generic normalization.
   - TCGplayer fixture proves provider-product output is produced by generic normalization.
   - TCGplayer repricing/listing fields do not change hash material.
   - Missing required fields produce redaction-safe diagnostics without leaking provider values.

## Verification

- `pnpm exec vitest run --config ./tests/vitest.config.mjs features/source-observations/api/provider-source-observation-normalizer.test.ts features/source-observations/api/tcgdex-client.test.ts features/source-observations/api/tcgplayer-automation-catalog-client.test.ts`
- `pnpm --filter @chase-sets/catalog run test:unit`
- `pnpm run verify:typecheck`
- `pnpm run check:localization`

## Rollback

Revert the PR. Current provider transport paths will remain intact and no database schema changes are planned for this slice.
