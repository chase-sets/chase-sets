# Search Card Variant Subtitle

## Intent

Search result cards need to distinguish visually identical Pokemon card variants before image assets catch up. The card should surface Catalog identity facts that matter while scanning: expansion/set, card number, print or parallel variant, and rarity. The current "Make an offer or list yours to help this market form." copy repeats nearby actions and hides the more important identity line.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-search-card-variant-subtitle`
- Branch: `codex/search-card-variant-subtitle`
- Sandbox id: `97f8be82`
- Dependency setup status: complete via `pnpm run deps:install`; `pnpm run sandbox:doctor` passed.
- pnpm store path: default embedded worktree store, `.codex/worktrees/.chase-sets-pnpm-store`.
- Setup blockers: none found.

## Owning Contexts

- Catalog owns the canonical Catalog Item facts, Pokemon card fields, Source Observation promotion, and the Catalog Item subtitle.
- Discovery owns Search Result read models and search-card presentation.
- Marketplace owns Listing and Offer facts only. It should not own the identity copy that distinguishes two Catalog Items.
- Design System owns the reusable `ListingCard`, `ProductOptions`, and marketplace search-card patterns. Search should consume those patterns instead of adding route-local styling overrides.

## Resolved Decisions

- Recommended immediate product decision: display `Catalog Item.subtitle` prominently on Discovery search cards, directly under the title, and remove the redundant empty-market value cue.
- For Pokemon singles, the Catalog Item subtitle is already the right base identity line because promotion builds it from `expansionName`, `cardNumber`, `cardVariantLabel`, and `rarity`.
- Keep the top metadata row for quick classification, but do not let `blueprint_name` replace the subtitle. Blueprint/category tells the buyer this is a Pokemon card single; subtitle tells them which version.
- Do not move the "Make an offer or list yours..." text elsewhere on the card. Empty-market state is already communicated by `Market open`, `No active listings`, `Supply wanted`, and Buy/Sell/Watch actions.
- The robust subtitle should remain Catalog-owned as canonical item copy, not assembled ad hoc from field labels inside the route.
- Discovery can add a presentation helper such as `formatSearchIdentityLine(item)` that prefers `item.subtitle`, then falls back to meaningful category/blueprint context for non-card items.
- If future search needs independent structured identity chips, Discovery should project a small `identity_facets` or `display_facts` shape from Catalog field/reference facts rather than parsing subtitle strings.

## Repo Evidence

- `bounded-contexts/catalog/README.md` states Catalog owns canonical product facts, Source Observations, and promotion into Catalog Items.
- `bounded-contexts/catalog/GLOSSARY.md` states Fields describe Catalog Items, while Product identity is Catalog Item plus selected Options. Print/parallel variant is therefore Catalog Item copy, not Marketplace copy.
- `.codex/plans/20260519-tcgdex-variant-catalog-items.md` decided that Catalog Item titles remain the printed card name and subtitles carry expansion, card number, variant label, and rarity.
- `.codex/plans/20260520-tcgdex-pokemon-variant-terminology.md` corrected the variant language to `Standard Set`, `Standard Set Foil`, `Parallel Set - Reverse Foil`, and premium parallel labels.
- `bounded-contexts/catalog/features/source-observations/api/runtime.ts` formats Pokemon card subtitles as expansion name, card number, card variant label, and rarity.
- `bounded-contexts/catalog/features/fields/api/seed.ts` defines `Card Number`, `Expansion`, `Rarity`, and `Card Variant` as filterable/searchable Catalog fields.
- `bounded-contexts/discovery/features/search/ui/search-page.tsx` currently passes `availability={item.blueprint_name ?? item.subtitle ?? ...}` and `valueCue={formatValueCue(item)}`, so a Pokemon card with a blueprint hides its subtitle and shows the redundant empty-market sentence instead.
- `packages/design-system/MARKETPLACE_SYSTEM.md` says search result cards may use compact Buy / Sell / Watch actions while the user scans, and identity/action clarity should preserve buyer momentum.

## Implementation Checklist

- Completed: added an optional design-system `ListingCard.subtitle` slot so item identity copy is not overloaded into `valueCue`.
- Completed: updated Discovery search cards to pass the Catalog Item subtitle as the card subtitle.
- Completed: kept `availability` focused on blueprint/category classification instead of using the subtitle as a fallback ahead of blueprint.
- Completed: removed the empty-market `formatValueCue` call from Discovery search cards.
- Completed: added focused UI coverage proving two same-title Abra results with the same image can be distinguished by `Base Set 43 Standard Set Common` and `Base Set 43 Parallel Set - Reverse Foil Common`.
- Completed: updated the marketplace route adapter test that previously expected `Make an offer or list yours to help this market form.`
- Completed: ran focused Discovery, design-system, and marketplace route tests plus typecheck/static verification.

## Verification

- `pnpm run deps:install` passed.
- `pnpm run sandbox:doctor` passed for sandbox `97f8be82`.
- `pnpm --filter @chase-sets/discovery run test -- features/search/ui/search-page.test.tsx` passed: 15 tests.
- `pnpm --filter @chase-sets/design-system run test -- src/__tests__/design-system.test.tsx` passed: 55 tests.
- `pnpm --filter @chase-sets/app-marketplace-web run test -- app/routes/search.test.tsx` passed: 13 tests.
- `pnpm run verify:typecheck` passed.
- `pnpm run verify:static` passed.

## Documentation To Promote

- No durable architecture doc is required for the immediate fix.
- If a structured `display_facts` projection is added later, document it in `bounded-contexts/discovery/docs/dynamic-search-filters.md` or a new Discovery search-result presentation note because it would become a search-read-model contract.

## Stress Test

- Normal flow: variants with different Catalog subtitles become distinguishable in a two-column grid even when images are identical.
- Partial flow: items without subtitles still render using existing blueprint/category context.
- Stale data or replay: fixing the search UI immediately helps already projected subtitles; changing Catalog subtitle composition would require normal projection replay.
- Cross-context handoff: Marketplace continues supplying listing/offer counts only; Discovery does not infer identity from commercial state.
- Failure/cancellation: if image updates are delayed, subtitle copy still protects buyers from choosing the wrong variant.
- Low-value card economics: faster variant disambiguation reduces mistaken carts, mistaken offers, and support load on low-margin items.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
