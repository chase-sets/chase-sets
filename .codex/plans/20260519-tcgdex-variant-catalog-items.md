# TCGDex Variant Catalog Items

## Intent

TCGDex Pokemon card imports must treat each declared print/parallel variant as its own reviewable Source Observation and, when promoted, as its own Catalog Item. Catalog Item identity needs to clearly identify the version using Pokemon marketplace language where possible, such as `Standard Set`, `Standard Set Foil`, `Parallel Set - Reverse Foil`, `1st Edition`, `Premium Parallel Set - Poke Ball`, and `Premium Parallel Set - Master Ball`, rather than exposing raw TCGDex variant keys.

Variant Catalog Items may temporarily point at TCGDex provider image URLs while they are still Source Observations. During promotion, image assets remain Catalog-owned under `catalog/items/{catalog_item_id}`. When TCGDex only supplies the main card image for a variant, the promoted Catalog Item needs a visible description disclaimer that the image may not show the exact foil or pattern.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260519-tcgdex-variant-catalog-items`
- Branch: `codex/tcgdex-variant-catalog-items`
- Base: `origin/main` at `582068b6 Replace mobile commerce toggle with actions`
- Sandbox id: `b114b254`
- Dependency setup status: complete via `pnpm run deps:install`; `pnpm run sandbox:doctor` passed
- pnpm store path: default embedded worktree store, `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none found

## Owning Contexts

- Catalog owns Source Observations, canonical Catalog Items, Product Asset Sets, Pokemon card fields, reference data, and promotion behavior.
- No downstream bounded context should infer variant identity from TCGDex keys. Catalog should publish distinct Catalog Item facts and downstream commerce should continue consuming `catalog_item_id` and `product_id`.

## Resolved Decisions

- Source Observations become variant-specific for TCGDex Pokemon cards. `fetchTcgdexSetObservations` will expand one provider card into one observation per true variant key, with variant-specific normalized metadata and source hash. The primary variant reuses the provider card's original observation/external key for compatibility; secondary variants append the normalized variant key.
- Promotion remains one Source Observation to one Catalog Item. This preserves existing review/retry/status semantics and avoids ambiguous multi-item promotion results.
- Catalog Item titles remain the printed card name. Subtitles carry the expansion, card number, Pokemon-language variant label, and rarity so list/detail pages can distinguish versions.
- Add an optional `Card Variant` Catalog field for Pokemon card singles so variant identity is a first-class descriptive fact, filterable/searchable/sortable, and not buried only in tags or subtitle text.
- Known TCGDex variant keys map to Pokemon/marketplace language:
  - `normal` -> `Standard Set`
  - `holo` -> `Standard Set Foil`
  - `reverse` -> `Parallel Set - Reverse Foil`
  - `firstEdition` / `1stEdition` -> `1st Edition`
  - `pokeBall` / `pokeball` -> `Premium Parallel Set - Poke Ball`
  - `masterBall` / `masterball` -> `Premium Parallel Set - Master Ball`
- Unknown provider variant keys will be humanized and labeled as `Unclassified Variant - <Label>` so imports remain forward-compatible without publishing raw TCGDex key casing or asserting unsupported parallel-set membership.
- Promoted non-standard variants with TCGDex images will receive a description note that the image came from the provider card image and may not show the exact foil or pattern.
- External product references for secondary variants should include the variant key, e.g. `en:swsh3-136:reverse-holo`, so multiple Catalog Items can trace back to the same provider card without collapsing distinct variants. The primary variant keeps the unsuffixed provider card key for compatibility with existing observations.

## Repo Evidence

- `bounded-contexts/catalog/README.md` defines Catalog as the owner of Source Observations and canonical Catalog Items.
- `bounded-contexts/catalog/GLOSSARY.md` says Product identity is Catalog Item plus selected options, while Catalog Item fields describe item identity. Print/parallel variants should therefore be Catalog Item facts, not raw/graded Product options.
- `bounded-contexts/catalog/docs/source-observation-integration.md` says provider integrations write Source Observations and promotion creates Catalog Items, with TCGDex images mirrored only during promotion.
- `bounded-contexts/catalog/features/source-observations/api/tcgdex-client.ts` currently stores `variants` as a normalized blob and creates one observation with `buildObservationId(languageCode, card.id)`.
- `bounded-contexts/catalog/features/source-observations/api/runtime.ts` currently promotes one Source Observation into one draft Catalog Item and builds image assets under `catalog/items/{catalog_item_id}/product-image`.
- `bounded-contexts/catalog/features/source-observations/read-model/schema.ts` enforces `UNIQUE (provider_key, language_code, external_key)`, so variant-specific external keys are required if one provider card produces multiple reviewable observations.
- `bounded-contexts/catalog/features/fields/api/seed.ts` and `bounded-contexts/catalog/features/blueprints/api/seed.ts` own Pokemon card field availability; `Card Variant` belongs there as an optional Pokemon single field.

## Implementation Checklist

- Extend `SourceObservationNormalized` with variant key/label/image notice metadata.
- Expand TCGDex set import so each true provider variant emits a distinct observation.
- Keep card imports with no declared true variants as one `standard` observation for backward compatibility.
- Add variant label normalization with tests covering parallel set reverse foil, Poke Ball, Master Ball, first edition, and unknown keys.
- Add optional `card-variant` field seed and blueprint rule.
- Set `card-variant`, subtitle, tags, description disclaimer, image URLs, Product Asset Set, and external reference during promotion.
- Update Source Observation detail UI to show variant and image note.
- Update source observation integration docs to document variant observations and image disclaimer behavior.
- Run focused Catalog tests, then broader verification after dependency setup.

## Documentation To Promote

- Update `bounded-contexts/catalog/docs/source-observation-integration.md` with the variant import/promotion behavior.
- No ADR needed: this follows the existing Catalog Source Observation and Catalog Item ownership model.

## Verification

- `pnpm run deps:install` passed.
- `pnpm run sandbox:doctor` passed for sandbox `b114b254`.
- `pnpm --filter @chase-sets/catalog run test -- features/source-observations/api/tcgdex-client.test.ts features/source-observations/domain/domain.test.ts features/source-observations/api/runtime.test.ts features/source-observations/ui/source-observation-list-page.test.tsx` passed: 17 tests.
- `pnpm --filter @chase-sets/catalog run test` passed: 166 passed, 4 skipped.
- `pnpm run verify:typecheck` passed.
- `pnpm run verify:static` passed.
- `pnpm run verify:test` passed.
- `pnpm run verify:build` passed.
- `pnpm run verify:metadata` passed.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
