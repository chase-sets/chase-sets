# Listing And Offer Reputation Revamp

## Intent

Revamp listing and offer decision surfaces so account reputation appears once, trust signals stay clear, and listing/offer commerce facts remain easy to scan on mobile and desktop.

## Worktree

- Path: `D:/Users/ToddS/Source/Repos/chase-sets/.codex/worktrees/20260517-listing-offer-reputation`
- Branch: `codex/listing-offer-reputation`
- Sandbox id: `257241a2`
- Dependency setup status: `pnpm run deps:install` completed
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: sandbox command execution intermittently required escalation for read-only commands; dependency setup and `pnpm run sandbox:doctor` succeeded

## Owning Contexts

- Design System owns reusable marketplace component contracts and layout patterns.
- Discovery owns public listing, seller, search, and item-detail presentation models.
- Marketplace owns listing and offer workflows before an order exists.
- Reputation owns canonical account review summaries and should remain the source of rating/review-count truth for any account role.

## Resolved Decisions

- The duplicate reputation display should be fixed by a design-system contract change, not by route-local hiding or CSS.
- Listing cards should present one compact seller account reputation row: seller account name, verification/status, and one rating summary when available.
- Offer cards should present buyer account reputation when account attribution is shown. Marketplace-wide offers are buyer demand, not seller-specific supply.
- Detailed account reputation belongs in a single trust module or account feedback link, not repeated below the primary card.
- Public listing detail should treat the purchase panel as the buying decision surface and the seller trust module as supporting detail. They should not both headline the same rating.
- Discovery should only display average rating and review count after adding an explicit projection or API composition from Reputation summary facts. It should not infer trust from listing availability or Marketplace status.
- Product options should stay structured chips (`Form: Raw`, `Condition: Near Mint`) and should not be nested under a generic `Product` label when space is tight.
- The first implementation pass uses the design-system `AccountReputationSummary` primitive and adopts it where current data already exists. A later read-model change can project Reputation summary fields into additional Discovery/Marketplace surfaces once canonical account review summary integration is designed.

## Open Questions

- None for the first implementation pass.

## Implementation Checklist

- Completed: Reuse the `AccountReputationSummary` primitive in `packages/design-system` for compact listing/offer rows and expanded modules.
- Completed: Refactor `ListingCard`, `ListingPurchasePanel`, `SellerTrustCard`, and `OfferCard` to consume the same account reputation shape.
- Completed: Keep backwards-compatible rating/review props only as transitional inputs that map into the unified reputation primitive.
- Completed: Update Discovery public listing to show seller account reputation once in the purchase panel.
- Completed: Update Marketplace offer-match screens so offers use buyer account attribution consistently without implying seller-specific reputation for marketplace-wide offers.
- Completed: Add focused design-system tests for no duplicate rating output and one dominant primary action.
- Completed: Add Marketplace offer-match test coverage for buyer account reputation.

## Verification

- `pnpm run deps:install` passed.
- `pnpm run sandbox:doctor` passed for sandbox `257241a2`.
- `pnpm --filter @chase-sets/design-system exec vitest run src/__tests__/design-system.test.tsx` passed.
- `pnpm --filter @chase-sets/marketplace exec vitest run features/offers/ui/offer-match-list-page.test.tsx` passed.
- `pnpm run check:localization` passed.
- `pnpm run check:structure` passed.
- `pnpm run verify:typecheck` passed.
- `pnpm run verify:static` passed.
- `pnpm run verify:test` passed.
- `pnpm run verify:build` passed.
- Local marketplace server smoke: `http://localhost:11103` returned HTTP 200.
- Rebased on `origin/main` at `cf8d181f` and resolved upstream `AccountReputationSummary` conflicts by keeping buyer reputation on offer-match surfaces and seller reputation on listing surfaces.
- Post-rebase `pnpm --filter @chase-sets/design-system exec vitest run src/__tests__/design-system.test.tsx` passed.
- Post-rebase `pnpm --filter @chase-sets/marketplace exec vitest run features/offers/ui/offer-match-list-page.test.tsx` passed.
- Post-rebase `pnpm run check:localization` passed.
- Post-rebase `pnpm run verify:static` passed.
- Post-rebase `pnpm run verify:typecheck` passed after rerunning with a longer timeout; the first run exceeded 3 minutes without a failure.
- Post-rebase `pnpm run verify:test` passed.
- Post-rebase `pnpm run verify:build` passed.

## Documentation To Promote

- Added `Account Reputation Summary Contract` to `packages/design-system/MARKETPLACE_SYSTEM.md`.

## Goal Completion Criteria

- Completed: PR submitted for the completed implementation: https://github.com/todd-skelton/chase-sets/pull/185.
- Pending: CI passing on the PR before merge. GitHub currently reports no status checks or Actions runs for branch `codex/listing-offer-reputation`.
- Pending: PR merged after required review and passing checks.
- Pending: Staging deployment verified green after merge.
- Pending: Production deployment verified green after promotion or rollout.
