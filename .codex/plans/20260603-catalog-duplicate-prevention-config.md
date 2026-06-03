# Catalog Duplicate Prevention Config

## Issue

[#628](https://github.com/chase-sets/chase-sets/issues/628) - Make duplicate-prevention and merge candidate rules config-driven.

## Context

Source Observation promotion currently chooses an existing Catalog Item with provider-specific helper order in `runtime.ts`: promoted/changed observation target, external Catalog Item references, source Product reference, deterministic Pokemon card fields, and partially promoted draft evidence. The provider mapping contract has duplicate-prevention metadata, but it only carries expression evidence and booleans; it cannot describe the ordered identity rule strategy that the runtime executes.

The previous slices made normalization, external references, selected options, reference hierarchy, and promotion command planning profile-driven. This slice moves duplicate-prevention orchestration behind provider profile identity rules while preserving current TCGdex Pokemon behavior and cross-provider TCGplayer Product ID reuse.

## Plan

1. Add duplicate-prevention identity rule types to the static provider profile and executable mapping contract:
   - exact external Catalog Item reference
   - source observation link
   - deterministic Pokemon card field match
   - partial draft Pokemon card retry match
   - sealed product deterministic match
   - barcode/GTIN match
   - future provider bridge match
2. Seed TCGdex and TCGplayer profile duplicate-prevention mappings with ordered rules. TCGdex keeps exact external Catalog Item references first so TCGdex-first, TCGplayer-first, and Scrydex/Scryfall-style observations can reuse the same Catalog Item when they share a TCGplayer Product ID.
3. Add a `provider-duplicate-prevention-resolver` module that evaluates identity rules in order and returns:
   - `matched` with the reusable Catalog Item and evidence summary
   - `none` when no rule matches
   - `blocked` for ambiguous matches under `block-promotion`
   - `review-only` with candidate evidence under review-only policy
4. Move the current runtime duplicate lookup SQL into rule handlers inside the resolver. Runtime should call the resolver once and execute create vs refresh based on the result.
5. Keep sealed-product and barcode/GTIN rules represented but inactive for current Pokemon-card promotion until later profile migrations provide valid mappings.
6. Add tests for rule ordering, exact external reference reuse across providers, deterministic single-card matching, sealed-product non-reuse of single-card identity, ambiguity blocking, and review-only candidate output.

## Tradeoffs

- This slice does not build a generalized SQL compiler for arbitrary identity expressions. It introduces the executable rule boundary and moves existing behavior into rule handlers with explicit profile data.
- Deterministic Pokemon card matching still depends on resolved Catalog field IDs and Reference Records. The resolver accepts those dependencies so profile field keys remain the source of truth.
- Review-only candidates are returned by the resolver for admin/dry-run use, but existing promotion continues to block only when profile policy says `block-promotion`.

## Verification

- Focused unit tests for the duplicate-prevention resolver and runtime promotion behavior.
- Existing provider profile and mapping contract tests.
- `pnpm --filter @chase-sets/catalog run test:unit`
- `pnpm run verify:typecheck`
- `pnpm run check:localization`
- Prettier check on touched files.
- `git diff --check`

## Delivery

- Open a PR linked to #628 with this finished plan.
- Wait for required checks and merge queue.
- Verify Platform Deploy staging and production jobs for the merge commit.
- Check #628 in the #637 tracker and close #628 only after deploy verification.
- Run scoped cleanup: `pnpm run dev:down; pnpm run sandbox:clean`, remove the worktree, and delete the local/remote branch.
