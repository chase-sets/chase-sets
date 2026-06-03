# Make Selected Option and Product Reference Mapping Config-Driven

## Issue

- GitHub: #625
- Milestone: Catalog integration config/data-driven migration
- Label: integration:catalog-config-mapping

## Current State

- TCGplayer SKU Product references are already guarded by
  `extractCatalogProviderExternalReferences`, which requires non-empty validated
  `selectedOptions` before emitting a Product reference.
- The selected Options themselves are still resolved in
  `tcgplayer-automation-catalog-client.ts` by hardcoded functions:
  `resolveTcgplayerSkuSelectedOptions`, `providerValueForDimension`, and
  `normalizeProviderOption`.
- `CatalogProviderSelectedOptionMapping` exists, but it is TCGplayer-specific
  and not interpreted generically.
- The Product reference schema passed to the integration carries active
  dimension/option identity plus provider aliases. Catalog dimension option read
  models currently store option `code`, `label`, `status`, and numeric values,
  but not provider aliases; provider aliases should therefore remain
  provider-profile data for this slice.
- Unknown condition, variant, language, or product form evidence currently
  prevents SKU Product references from being emitted. SKU evidence remains on
  `skuReferences` for review.

## Target Design

Add a Catalog-owned selected-option resolver that:

1. Interprets `CatalogProviderSelectedOptionMapping` instead of TCGplayer
   branches.
2. Reads provider evidence from a provider payload and record payload by
   configured source paths.
3. Resolves provider values through profile-owned aliases.
4. Validates resolved options against the active Product schema dimensions and
   active/allowed option ids supplied by the caller.
5. Emits deterministic `selectedOptions` only when required dimensions resolve.
6. Emits structured review evidence and diagnostics for missing, unknown,
   inactive, disallowed, or not-applicable dimensions.
7. Feeds validated selections into the existing external reference extractor so
   Product reference emission remains centralized.

## Implementation Plan

1. Generalize `CatalogProviderSelectedOptionMapping`.
   - Replace the fixed `condition`, `variant`, `language`, `sealedForm` shape
     with an ordered `dimensions` array.
   - Each rule defines:
     - `dimensionKey`
     - `providerValue` selector scope: record, payload, or constant
     - alias table key or inline aliases
     - `required`
     - unknown policy
     - optional product-form value mapping for sealed/unsealed facts
   - Keep TCGplayer's current profile behavior by encoding condition, printing,
     language, and product-form rules in data.

2. Add `provider-selected-option-resolver.ts`.
   - Inputs:
     - selected-option mapping config
     - provider payload
     - provider record, usually a SKU
     - active Product reference schema
   - Outputs:
     - `selectedOptions`
     - `reviewEvidence`
     - `diagnostics`
     - `resolved` boolean
   - Normalize aliases with the same provider-option normalization used by the
     mapping interpreter.
   - Sort selected Options by schema order, then option id for deterministic
     replay.

3. Extend the Product reference schema type for this slice.
   - Preserve the existing test-facing schema shape.
   - Add optional `status`/active metadata where useful.
   - Treat missing status as active for backwards compatibility.
   - Do not promote inactive or disallowed options into selected Options.

4. Wire TCGplayer SKU mapping through the generic resolver.
   - Build SKU records with `selectedOptions` by calling the resolver with
     `tcgplayerAutomationClientProviderProfile.selectedOptionMapping`.
   - Keep SKU `reviewEvidence` on every SKU reference.
   - Add resolver diagnostics/review evidence to SKU review evidence when a SKU
     cannot publish a Product reference.
   - Remove TCGplayer-specific selected-option helpers once the generic resolver
     covers them.

5. Add focused contract tests.
   - Valid TCGplayer SKU emits Product reference with selected Options.
   - Unknown condition, variant, language, and product form remain review
     evidence and do not emit invalid Product references.
   - Missing required dimensions block Product references.
   - Optional inactive/not-applicable dimensions are omitted.
   - Active and inactive option cases are covered.
   - Alias normalization covers punctuation/case variants.
   - Replay is deterministic: same payload/schema/config yields identical
     ordering and reference output.
   - Product ID-only rows do not infer Product references without valid provider
     or import-row selected-option evidence.

6. Update docs and profile tests.
   - `provider-integration-profiles` tests should assert the selected-option
     mapping is data-driven.
   - TCGplayer contract docs should describe profile-owned aliases and active
     Product schema validation.

## Acceptance Criteria

- TCGplayer SKU Product references are created only when selected Options
  resolve through profile config and active Product schema data.
- Unknown or inactive condition, variant, language, or form values remain review
  evidence.
- Product ID-only evidence still cannot create Product references unless valid
  selected-option evidence is present.
- Existing external reference extraction behavior from #624 remains intact.
- Focused unit tests, Catalog unit tests, typecheck, localization, formatting,
  and whitespace checks pass.

## Verification

- `pnpm exec vitest run --config ./tests/vitest.config.mjs features/source-observations/api/provider-selected-option-resolver.test.ts features/source-observations/api/provider-external-reference-extractor.test.ts features/source-observations/api/tcgplayer-automation-catalog-client.test.ts features/source-observations/api/provider-integration-profiles.test.ts`
- `pnpm --filter @chase-sets/catalog run test:unit`
- `pnpm run verify:typecheck`
- `pnpm run check:localization`
- `pnpm exec prettier --check .codex/plans/20260603-catalog-selected-option-config-mapping.md bounded-contexts/catalog/features/source-observations/api/provider-selected-option-resolver.ts bounded-contexts/catalog/features/source-observations/api/provider-selected-option-resolver.test.ts bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.ts bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.test.ts bounded-contexts/catalog/features/source-observations/api/tcgplayer-automation-catalog-client.ts bounded-contexts/catalog/features/source-observations/api/tcgplayer-automation-catalog-client.test.ts`
- `git diff --check`
