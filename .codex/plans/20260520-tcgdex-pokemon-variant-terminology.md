# TCGDex Pokemon Variant Terminology

## Intent

TCGDex variant imports must create distinct Source Observations and Catalog Items while using official Pokemon set language instead of provider or collector shorthand. The current map incorrectly exposes `Reverse Holo` and `Holofoil` as top-level Catalog variant labels. Pokemon checklists and TCG Live drop-rate language use `standard set`, `standard set foil`, `parallel set`, and premium parallel set terms; finish details such as reverse, cosmos, mirror, Poke Ball, and Master Ball belong as foil/pattern language inside the variant display, not as the set bucket itself.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-tcgdex-pokemon-variant-terminology`
- Branch: `codex/tcgdex-pokemon-variant-terminology`
- Sandbox id: `84b6be4d`
- Dependency setup status: complete via `pnpm run deps:install`; `pnpm run sandbox:doctor` passed
- pnpm store path: default embedded `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Catalog owns Source Observations, Catalog Item promotion, Pokemon card fields, and Catalog Item copy because Catalog owns canonical truth for what can be bought or sold.
- Source Observations owns provider normalization before review and promotion.

## Resolved Decisions

- Keep one Source Observation and one promoted Catalog Item per TCGDex declared print/parallel variant.
- Preserve the existing `cardVariantKey` compatibility shape unless implementation pressure proves a small additive field is lower risk.
- Use official Pokemon set-bucket labels for `cardVariantLabel`:
  - `normal` / `standard` -> `Standard Set`
  - `holo` / `holofoil` -> `Standard Set Foil`
  - `reverse` / `reverseHolo` / `reverseHolofoil` -> `Parallel Set - Reverse Foil`
  - `pokeBall` -> `Premium Parallel Set - Poke Ball`
  - `masterBall` -> `Master Ball Premium Parallel Set`
- Treat `parallelSet` as true only for canonical parallel and premium parallel variants, not every non-standard variant.
- Unknown provider variant keys must not be asserted as parallel sets. They should display as `Unclassified Variant - <Label>` until explicitly mapped.
- Image disclaimers should say the shared image may not show the exact foil or pattern, and should use the corrected variant label.

## Repo Evidence

- `bounded-contexts/catalog/README.md` states Catalog owns provider Source Observations and promotion into canonical Catalog Items.
- `bounded-contexts/catalog/GLOSSARY.md` states Source Observations are provider-sourced candidate records reviewed before becoming Catalog truth.
- `.codex/plans/20260516-pokemon-reference-seeding.md` already recorded that official Pokemon card checklists use `standard set`, `standard set foil`, and `parallel set`, and that TCGDex `variants.reverse` should map to official `Parallel set` terminology without exposing `reverse holo`.
- Current implementation mapped `holo` to `Holofoil`, `reverse` to `Reverse Holo`, and unknown keys to `Parallel set - <Label>` before this correction.

## Implementation Checklist

- Completed: updated the TCGDex variant normalization map to use `Standard Set`, `Standard Set Foil`, `Parallel Set - Reverse Foil`, premium parallel set labels, and `Unclassified Variant - <Label>` for unknown provider keys.
- Completed: updated `parallelSet` to true only for mapped parallel/premium-parallel variants.
- Completed: updated Source Observation domain/test fixtures, runtime promotion tests, and UI fallback copy.
- Completed: updated durable docs and the prior retained TCGDex variant plan wording so future work does not reintroduce the conflict.
- Completed: ran focused Catalog tests and broader repo verification.

## Verification

- `pnpm run deps:install`
- `pnpm run sandbox:doctor`
- `pnpm --filter @chase-sets/catalog run test`
- `pnpm run verify:typecheck`
- `pnpm run verify:static`
- `pnpm run verify:test`
- `pnpm run verify:build`
- `pnpm run verify:metadata`

## Documentation To Promote

- Update `bounded-contexts/catalog/docs/source-observation-integration.md` with the canonical map.
- Update the retained TCGDex variant plan with a correction note so the historical plan does not remain misleading.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
