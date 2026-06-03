# Make Reference Hierarchy Provisioning Config-Driven

## Issue

- GitHub: #626
- Milestone: Catalog integration config/data-driven migration
- Label: integration:catalog-config-mapping

## Current State

- `ensurePokemonReferenceHierarchy` provisions Pokemon manufacturer, product
  line, series, and expansion Reference Types and Reference Records directly in
  Source Observations runtime code.
- The helper is already replay-safe: it looks up records by type/key and by
  provider attributes before creating records, publishes draft records, and
  preserves deterministic TCGdex ids through `ref_tcgdex_series_*` and
  `ref_tcgdex_expansion_*`.
- Provider profiles currently expose only `referenceHierarchyMapping` with a
  provider reference id prefix and provider attribute keys for `series` and
  `expansion`.
- TCGplayer has product-line and set-name evidence in its profile, but no
  declarative reference hierarchy rules capable of representing that evidence.

## Target Design

Add profile-owned reference hierarchy provisioning rules and a small
interpreter/provisioner that:

1. Defines Reference Types declaratively.
2. Defines static and provider-derived Reference Records declaratively.
3. Builds deterministic record ids from configured seed ids or provider id
   templates.
4. Resolves provider attributes from normalized Source Observation evidence.
5. Creates parent relationships by referring to previously resolved rule keys.
6. Reuses the existing idempotent create/publish safeguards.
7. Preserves the current TCGdex hierarchy and record ids.

## Implementation Plan

1. Extend `CatalogProviderIntegrationProfile.referenceHierarchyMapping`.
   - Add `referenceTypes` with id, type key, name, description, and allowed
     attribute keys.
   - Add ordered `referenceRecords` rules with:
     - stable rule key
     - type key
     - `recordId` mode: static id or provider-derived id using the profile
       prefix
     - key/name/description selectors or static values
     - attributes from static values or normalized payload paths
     - optional required condition path
     - relationships to earlier rule keys
   - Keep existing `providerReferenceIdPrefix` and `providerAttributes` for
     compatibility while routing runtime behavior through the richer rules.

2. Add `provider-reference-hierarchy-provisioner.ts`.
   - Input: provider profile, normalized observation payload, runtime deps,
     reference-data services, and event context.
   - Output: resolved record ids by rule key plus the target expansion/set
     Reference Record id.
   - Implement small value resolution helpers for path/static/template values.
   - Implement deterministic provider id creation using the same normalization
     as the old helper.
   - Keep missing optional series behavior: when no TCGdex series exists, the
     expansion relates to the Pokemon TCG product line.

3. Wire `ensurePokemonReferenceHierarchy`.
   - Keep the exported function signature for callers/tests.
   - Delegate to the generic provisioner with the TCGdex profile and normalized
     Pokemon card observation.
   - Return the resolved expansion Reference Record id.
   - Keep existing lower-level `ensureReferenceType`, `ensureReferenceRecord`,
     publish helpers, and provider-attribute lookup, generalized as needed.

4. Add TCGplayer reference hierarchy rules.
   - Represent the Pokemon manufacturer and product line static roots.
   - Represent product-line/category and set-name evidence through provider
     attributes such as `tcgplayer-product-line-id` and `tcgplayer-set-name`.
   - TCGplayer remains planned; this slice proves the profile can express the
     evidence without making runtime imports active.

5. Add tests.
   - TCGdex hierarchy provisions the same Reference Type ids and Reference
     Record ids as today.
   - Existing type/key and provider-attribute matches are reused.
   - Missing TCGdex series falls back to product-line parent without throwing.
   - Expansion attributes include set id, abbreviation, card count, parallel set
     count, and release date only when present.
   - TCGplayer profile rules can resolve product-line and set-name provider
     evidence without hardcoded helper branches.
   - Replay with the same input does not create duplicate records.

6. Update docs.
   - Document reference hierarchy rules in provider integration profiles and
     source observation integration docs.

## Acceptance Criteria

- Current TCGdex reference hierarchy is produced from profile rules.
- TCGplayer product-line and set-name reference evidence is representable in
  profile rules.
- Replay remains idempotent and existing TCGdex record ids are preserved.
- Focused tests, Catalog unit tests, typecheck, localization, formatting, and
  whitespace checks pass.

## Verification

- `pnpm exec vitest run --config ./tests/vitest.config.mjs features/source-observations/api/provider-reference-hierarchy-provisioner.test.ts features/source-observations/api/runtime.test.ts features/source-observations/api/provider-integration-profiles.test.ts`
- `pnpm --filter @chase-sets/catalog run test:unit`
- `pnpm run verify:typecheck`
- `pnpm run check:localization`
- `pnpm exec prettier --check .codex/plans/20260603-catalog-reference-hierarchy-config-provisioning.md bounded-contexts/catalog/features/source-observations/api/provider-reference-hierarchy-provisioner.ts bounded-contexts/catalog/features/source-observations/api/provider-reference-hierarchy-provisioner.test.ts bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.ts bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.test.ts bounded-contexts/catalog/features/source-observations/api/runtime.ts bounded-contexts/catalog/features/source-observations/api/runtime.test.ts bounded-contexts/catalog/docs/provider-integration-profiles.md bounded-contexts/catalog/docs/source-observation-integration.md`
- `git diff --check`
