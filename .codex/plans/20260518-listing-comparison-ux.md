# Listing Comparison UX

## Intent

Make the Discovery item-detail Listings area easier for buyers to compare and act on by turning listing cards into aligned comparison rows, making selection explicit, compressing repeated trust copy, calling out the lowest priced listing, and tying the selected listing more clearly to checkout actions.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-listing-comparison-ux`
- Branch: `codex/listing-comparison-ux`
- Sandbox id: `99077ef3`
- Dependency setup status: installed with `pnpm run deps:install`; `pnpm run sandbox:doctor` passed
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Discovery owns the item detail experience and the buyer-facing comparison presentation. The route is `bounded-contexts/discovery/features/item-detail/ui/item-detail-page.tsx`.
- Marketplace owns Listing lifecycle and listing facts. Discovery consumes projected Marketplace listing facts through `discovery-market-projection`; this change must not mutate Marketplace listing behavior.
- Checkout owns cart and checkout session orchestration. The item-detail buy panel receives the selected listing through `CheckoutPurchaseIntentSection`; this change may clarify copy in that handoff but must not move checkout rules into Discovery.
- Reputation owns canonical review summaries. Discovery consumes projected seller rating fields through the Discovery item-detail read model and should keep the listing row trust signal compact.

## Resolved Decisions

- Implement as a Discovery `item-detail` UI change over existing projected listing data. Repo evidence: Discovery README says it owns browse/search/detail; Marketplace README says it owns listings but not browse/item detail; `discovery/context.json` already allows dependencies on Marketplace and Checkout.
- Keep the default selection rule as lowest buyer price. Repo evidence: `sortListingsByBuyerPrice` sorts ascending by `price_amount`; tests already assert the cheapest listing is selected by default.
- Use an aligned card-row layout instead of a native HTML table so the UI keeps the existing card separation while gaining stable columns: Price, Seller, Trust, Quantity, Product, Action.
- Add an explicit right-aligned `Selected` / `Select` control for every buy listing row, while preserving keyboard-accessible selection behavior through the control itself.
- Add `Lowest price` to the first cheapest listing. Use this as an explanatory value cue, not a new Marketplace domain fact.
- Compress reputation/trust to one compact signal using projected rating data when present and neutral `No feedback yet` copy when not.
- Format availability as `<count> available` in-row so buyers understand the quantity belongs to that seller listing.
- Defer duplicate-seller grouping. Grouping changes row identity and selection mechanics when one seller has multiple prices or quantities. The requested highest-impact changes can be shipped without changing listing identity.
- Strengthen selected-card styling through existing design-system primitives and tokens, avoiding custom design-system overrides.

## Implementation Checklist

- Update the item-detail buy listings rows in `bounded-contexts/discovery/features/item-detail/ui/item-detail-page.tsx`.
- Add or update tests in `bounded-contexts/discovery/tests/item-detail-commerce-panel.test.tsx` for explicit selection controls, lowest-price badge, compact quantity copy, and buy-panel selected listing attribution.
- Keep server routes, schemas, projections, and Marketplace domain code unchanged unless tests reveal an existing contract gap.
- Run worktree dependency setup before verification.
- Run focused Discovery item-detail tests.
- Run structure or broader checks if the UI change touches exports or shared design-system contracts.

## Documentation To Promote

- No durable docs are required for the first implementation. If this becomes a reusable marketplace comparison pattern, promote it into `packages/design-system/` documentation or tests instead of documenting it inside a deployable.

## Verification

- `pnpm --filter @chase-sets/discovery test -- item-detail-commerce-panel` passed.
- `pnpm --filter @chase-sets/discovery test` passed.
- `pnpm run check:localization` passed.
- `pnpm exec tsc -p ./tsconfig.json --noEmit` passed.
- Browser smoke on `http://localhost:11153/items/pikachu-jungle-60-64-common-cat-seed-pikachu-jungle-1kwaurr` confirmed aligned listing rows, `Lowest price`, compact trust (`No feedback yet` plus feedback link for no-rating sellers), `<count> available`, explicit Select/Selected controls, and buy-panel updates after selecting the $18.75 Card Vault listing.
- Rebase verification note: local sandbox API needed `pnpm run dev:db:refresh` and a platform-api restart so main's new reputation columns were applied before browser smoke. Refresh completed API and worker bootstrap on retry; platform health returned 200 with projections caught up.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
