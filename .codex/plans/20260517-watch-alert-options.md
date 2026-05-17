# Watch Alert Options

## Intent

Move Product Alert creation out of the extra standalone watch placement on item detail commerce panels. The Buy area should offer Watch Listings, and the Sell area should offer Watch Offers, so the alert choices follow the buyer/seller intent already present on the page.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-watch-alert-options`
- Branch: `codex/watch-alert-options`
- Sandbox id: `fdc02ea9`
- Dependency setup status: completed with `pnpm run deps:install`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none found yet

## Owning Contexts

- Discovery owns the item detail page, product selection surface, Product Alert behavior, and Product Alert creation flow.
- Marketplace owns Listing and Offer lifecycle facts consumed by Product Alert matching, but this change does not alter Marketplace behavior, APIs, events, or read models.

## Resolved Decisions

- Keep Product Alert creation in Discovery item detail because alerts are created from selected Catalog Products on the Discovery Detail Page.
- Treat "Watch Listings" as a buyer-side option because listing alerts notify when supply appears at or below the buyer's maximum price.
- Treat "Watch Offers" as a seller-side option because offer alerts notify when demand appears at or above the seller's minimum price.
- Remove the separate offer-side watch placement from the Make Offer area because it creates a third commerce path that is more than the current product flow needs.
- Keep existing Product Alert commands, events, projections, notification policy, and thresholds unchanged.
- Use existing design-system primitives already present in the route; do not add route-local UI components or custom styling.

## Repo Evidence

- `bounded-contexts/README.md` fixes Listing and Offer ownership to Marketplace while Discovery may project browse-oriented read models.
- `bounded-contexts/discovery/README.md` says Discovery owns Product Alerts created from product detail selection and does not own listing or offer lifecycles.
- `bounded-contexts/discovery/GLOSSARY.md` defines Product Alert as an account-owned watch on a resolved Catalog Product from a Discovery Detail Page.
- `bounded-contexts/discovery/docs/product-alerts.md` says creating Product Alerts remains a Discovery item-detail flow because product selection, resolved options, and market-side intent are Discovery-owned behavior.
- `bounded-contexts/marketplace/GLOSSARY.md` defines Listing as supply and Offer as marketplace-wide demand, which supports placing listing alerts in Buy and offer alerts in Sell.
- Before this change, `bounded-contexts/discovery/routes/item-detail.tsx` rendered listing alerts in Buy and offer alerts in Make Offer on both desktop and mobile.

## Implementation Checklist

- [x] Update item detail commerce composition so Buy includes Watch Listings and Sell includes Watch Offers.
- [x] Remove Watch Offers from the Make Offer area.
- [x] Keep mobile commerce actions aligned with desktop: Buy shows Watch Listings, Sell shows Watch Offers.
- [x] Run focused checks for the Discovery item detail route and relevant tests.
- [x] Update this plan with dependency setup and verification results.

## Verification

- `pnpm run deps:install` completed successfully.
- `pnpm run sandbox:doctor` completed successfully for sandbox `fdc02ea9`.
- `pnpm --filter @chase-sets/discovery exec vitest run --config ./tests/vitest.config.mjs tests/item-detail-commerce-panel.test.tsx` passed after adding a route-level placement regression test.
- `pnpm --filter @chase-sets/discovery test` passed: 16 files passed, 1 skipped; 82 tests passed, 4 skipped.
- `pnpm exec tsc -p ./tsconfig.json --noEmit` passed.
- Initial PR CI failed the Unit Tests job because the route-level regression test allowed the realtime hook to schedule `EventSource` in jsdom. The test now mocks `@chase-sets/platform-runtime/realtime-react` so it verifies commerce composition without opening SSE.
- `pnpm run verify:test` passed locally after the realtime test-harness fix, matching the failed CI Unit Tests command.
- PR CI passed on commit `d5875cbd`, but merge was blocked because `main` advanced. The branch was rebased onto the latest `origin/main`.
- After rebase, `pnpm --filter @chase-sets/discovery exec vitest run --config ./tests/vitest.config.mjs tests/item-detail-commerce-panel.test.tsx` passed: 27 tests passed.
- After rebase, `pnpm --filter @chase-sets/discovery test` passed: 18 files passed, 1 skipped; 96 tests passed, 4 skipped.
- After rebase, `pnpm exec tsc -p ./tsconfig.json --noEmit` passed.
- Marketplace dev smoke attempted against `http://localhost:6453`, but the local dev target did not become reachable within the smoke timeout; `pnpm run dev:down` stopped the sandbox cleanly.

## Documentation To Promote

No durable documentation promotion is expected unless implementation reveals a term or ownership conflict. Existing Product Alert documentation already supports the chosen placement.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
