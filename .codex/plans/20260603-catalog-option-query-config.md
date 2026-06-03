# Catalog Option Query Config

## Issue

[#629](https://github.com/chase-sets/chase-sets/issues/629) - Generalize provider option queries and import scopes from profile config.

## Context

Source Observation integration options still branch directly in `runtime.ts` for provider listing, TCGdex languages/series/expansions, and TCGplayer product-line/set-name queries. Provider profiles already declare option query kinds and parent scopes, but they do not yet describe aliases, parent value requirements, transport operations, or option DTO mapping.

This slice should move query selection and validation to profile data while keeping provider transport adapters responsible for executing named operations.

## Plan

1. Extend `CatalogProviderOptionQuery` with:
   - stable aliases for legacy query names
   - a named transport operation
   - parent value requirement policy
   - option output mapping metadata for value, label, description, parent, image URL, and metadata fields
2. Add profile query config for:
   - provider list
   - TCGdex languages, series, and expansions
   - TCGplayer product lines and set names
3. Add a `provider-option-query-resolver` module that:
   - resolves query kind/alias from profile data
   - validates provider status/capability and parent requirements from config
   - calls only named transport operations supplied by runtime
   - maps transport DTOs into `SourceObservationIntegrationOption`
   - produces unsupported query errors from profile-supported query config
4. Replace the hardcoded option-query branches in `runtime.ts` with the resolver and a transport operation table.
5. Add tests for TCGdex language/series/expansion options, TCGplayer product-line/set-name options, unsupported query errors, missing parent validation, and adding a Scrydex/Scryfall-style profile query without runtime branching.

## Tradeoffs

- This does not remove provider transport operations. It makes runtime selection data-driven while transport adapters still fetch provider data.
- Product and SKU option query mappings are represented for future profile support, but this slice keeps executable runtime coverage to the currently exposed options.
- Output mapping remains a constrained Catalog-owned config, not arbitrary JavaScript.

## Verification

- Focused unit tests for the option-query resolver and runtime route behavior.
- Existing provider profile and runtime tests.
- `pnpm --filter @chase-sets/catalog run test:unit`
- `pnpm run verify:typecheck`
- `pnpm run check:localization`
- Prettier check on touched files.
- `git diff --check`

## Delivery

- Open a PR linked to #629 with this finished plan.
- Wait for required checks and merge queue.
- Verify Platform Deploy staging and production jobs for the merge commit.
- Check #629 in the #637 tracker and close #629 only after deploy verification.
- Run scoped cleanup: `pnpm run dev:down; pnpm run sandbox:clean`, remove the worktree, and delete the local/remote branch.
