# Responsive Listing Actions

## Intent

Refine the Chase Sets catalog item Detail Page so buyers can compare Listings and act on the selected Listing cleanly across mobile, tablet, and desktop. Preserve the dark marketplace visual language while improving responsive hierarchy, density, alignment, product summaries, and selected Listing handoff to purchase actions.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-responsive-listing-actions`
- Branch: `codex/responsive-listing-actions`
- Sandbox id: `ce44afd9`
- Dependency setup status: installed with `pnpm run deps:install`; `pnpm run sandbox:doctor` passed
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Discovery owns the buyer-facing item Detail Page, including responsive layout, Listing comparison presentation, option selection, and selected Listing context on the Detail Page.
- Marketplace owns Listing lifecycle, seller asking price, and visible sell quantity. This iteration must use existing projected Listing facts and not change Listing behavior.
- Checkout owns Cart and Checkout Session behavior. This iteration may improve the Discovery-owned handoff and mobile action access, but must not move Checkout rules into Discovery.
- Reputation owns account review summaries. Discovery should show compact projected trust facts where available and neutral no-feedback copy otherwise.
- The design system is the canonical source for marketplace layout, sticky CTA, comparison, account reputation, and touch-target patterns; Discovery should compose existing primitives instead of deployable-level overrides.

## Resolved Decisions

- Implement as a Discovery `features/item-detail/ui` change. Repo evidence: Discovery owns browse/search/detail experiences; Marketplace explicitly does not own item detail discovery experiences; Checkout owns session/cart but not Listing comparison UI.
- Keep the existing three-column desktop shell from `MarketplaceProductDetailLayout`: media/details left, summary/market/Listings center, commerce rail right. Refine inside this shell instead of replacing it.
- Treat desktop Listing rows as compact comparison rows with one column header strip. Hide repeated field labels inside desktop rows and show labels only in mobile/card breakpoints.
- Treat mobile Listing rows as compact cards: top row price/badge/action, seller row with inline trust and feedback, detail row with availability and compact product summary.
- Do not group duplicate sellers in this iteration; grouping would alter row identity and selection mechanics. Keep each Listing selectable.
- Use existing `product_summary` or selected option details to render compact product copy such as `Raw · Excellent`; do not add backend fields.
- Keep `Select`/`Selected` as semantic buttons and preserve `aria-pressed`, explicit labels, focus behavior, and immediate selected Listing updates.
- Use the existing design-system mobile commerce action bar/bottom sheet. Refine its summary/action content to prioritize selected price, seller, availability, and Buy on mobile while keeping secondary actions available through the sheet.
- Make ProductSelector wrapping responsive by changing component/classes, not by duplicating option controls per breakpoint.

## Stress Tests

- Normal flow: default lowest-price Listing remains selected, buyer taps another Select button, buy panel/action bar updates immediately.
- Partial flow: incomplete product selections still direct the buyer to choose options before purchase actions.
- Stale/replayed data: no new read-model fields are required; missing ratings or product summaries fall back to compact existing copy.
- Cross-context handoff: Discovery passes the selected Listing to Checkout render callbacks; Checkout still owns session/cart action implementation.
- Low-value card economics: compact rows and a dominant Buy action reduce comparison cost without hiding seller, trust, quantity, or product condition.

## Implementation Checklist

- [x] Refactor Listing row rendering in `bounded-contexts/discovery/features/item-detail/ui/item-detail-page.tsx` for responsive desktop/tablet/mobile classes.
- [x] Add a compact product summary helper for Listings and selected mobile summary.
- [x] Make `ListingTrustSignal` inline/compact on mobile and avoid centered floating feedback links.
- [x] Refine mobile commerce summary/action bar so it reads like a bottom purchase bar: selected price, seller/availability, primary Buy action.
- [x] Improve ProductSelector wrapping in `bounded-contexts/discovery/features/item-detail/ui/product-selector.tsx` if existing segmented controls remain cramped.
- [x] Add/update focused tests in `bounded-contexts/discovery/tests/item-detail-commerce-panel.test.tsx` for compact product summary, mobile purchase summary, label suppression classes, selected state, and selection updating.
- [x] Run focused Discovery item-detail tests, full Discovery tests, localization check if text changes, TypeScript, and browser smoke across mobile/tablet/desktop viewports.

## Verification

- `pnpm --filter @chase-sets/discovery test -- item-detail-commerce-panel` passed after implementation and after the compact product summary formatter adjustment.
- `pnpm --filter @chase-sets/design-system test -- design-system.test` passed for the mobile action bar layout contract.
- `pnpm --filter @chase-sets/discovery test` passed.
- `pnpm --filter @chase-sets/design-system test` passed.
- `pnpm run check:localization` passed.
- `pnpm exec tsc -p ./tsconfig.json --noEmit` passed.
- `pnpm --filter @chase-sets/app-marketplace-web build` passed.
- `git diff --check` passed.
- Browser smoke used the in-app Browser on `http://localhost:9257/items/pikachu-jungle-60-64-common-cat-seed-pikachu-jungle-1kwaurr` and confirmed the item Detail Page renders Listings with compact `Raw · Excellent`, visible Select actions, and no horizontal overflow.
- Headless responsive smoke covered 390x844, 768x1024, and 1440x1000 viewports. All passed: no horizontal overflow, compact product text visible, legacy product chip text absent, inactive Select buttons visible, selected affordance visible, desktop headers visible only on desktop, mobile selected summary visible, and selected Listing context updated after choosing the $18.75 Listing.

## Documentation To Promote

- No durable docs required unless the responsive Listing row becomes a reusable design-system primitive. If it does, promote the pattern to `packages/design-system/MARKETPLACE_SYSTEM.md` or design-system tests in a later extraction.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
