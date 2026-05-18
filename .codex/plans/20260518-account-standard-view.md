# Account Standard View

## Intent

Standardize account attribution and reputation display into one design-system component that works for any account, whether it is currently buying, selling, or doing both. The component should show the account name, account-scoped feedback summary, and navigate to the public account page where listings and feedback are visible.

## Worktree

- Path: `D:/Users/ToddS/Source/Repos/chase-sets/.codex/worktrees/20260518-account-standard-view`
- Branch: `codex/account-standard-view`
- Sandbox id: `452468f0`
- Dependency setup: complete via `pnpm run deps:install`
- pnpm store path: `D:/Users/ToddS/Source/Repos/chase-sets/.codex/worktrees/.chase-sets-pnpm-store`
- Sandbox doctor: passed via `pnpm run sandbox:doctor`
- Setup blockers: none

## Owning Contexts

- Identity owns Account identity, display name, profile facts, and account page shell routes.
- Reputation owns Review, Feedback, and Review Summary facts.
- Discovery owns the public browse/account profile projection that combines Identity account facts, Marketplace listing facts, and Reputation review facts for public marketplace pages.
- Marketplace owns listing and offer workflows and should render projected account attribution, not create buyer-only or seller-only identity UI.
- Design System owns the reusable `AccountReputationSummary` component contract used across Discovery and Marketplace.

## Resolved Decisions

- Use Account as the neutral UI noun. Buyer and seller remain transaction roles only when describing the commerce endpoint in a transaction.
- Evolve `AccountReputationSummary` into the single reusable account-attribution control instead of adding another component.
- The control should be clickable as one unit when a public account href is available. The visible feedback affordance belongs inside the component so call sites do not duplicate "View feedback" links.
- Use `/accounts/:accountSlug` as the role-neutral public profile URL. Remove `/sellers/:slug` because seller is not a marketplace root concept and all accounts can buy and sell.
- Discovery should continue to orchestrate the public account profile because it already owns public listing/profile browse views and projects Identity, Marketplace, and Reputation facts into local read models.
- Marketplace account surfaces may render the component without a public href when they do not have a projected slug yet; adding account slugs to those read models is a follow-on projection contract, not a blocker for replacing local visual implementations.

## Evidence

- `bounded-contexts/README.md` fixes Account as the root identity and Buyer/Seller as transaction roles.
- `bounded-contexts/identity/README.md` and `GLOSSARY.md` make Account the canonical owner of marketplace participation.
- `bounded-contexts/reputation/README.md` and `GLOSSARY.md` make Review Summary and Feedback reputation-owned.
- `bounded-contexts/discovery/context.json` already projects Identity, Marketplace, and Reputation facts into `discovery_market_accounts`, `discovery_market_listings`, `discovery_buyer_offer_matches`, and review tables.
- `packages/design-system/MARKETPLACE_SYSTEM.md` already names `AccountReputationSummary` as the canonical component for account reputation.
- Current UI duplicates account display across `public-listing`, `item-detail-page`, marketplace offer rows, and `SellerTrustCard`, with several seller-only hrefs such as `/sellers/:slug#feedback`.
- User clarification: the marketplace must not expose `sellers/:slug` because all accounts are both buyers and sellers; public account profile routes and documentation must use Account language.

## Implementation Checklist

- [x] Update `AccountReputationSummary` styling and API to show account name, rating or no-feedback state, and optional feedback link text inside one polished clickable unit.
- [x] Replace Discovery item-detail `ReputationCue`/`ListingTrustSignal` with the standard component for both listing accounts and offer accounts.
- [x] Update Discovery public listing and public profile routes to use role-neutral account href helpers.
- [x] Add `/accounts/:accountSlug` public profile route and API surface and remove `/sellers/:sellerSlug` route usage.
- [x] Update tests for design-system rendering, item detail account links, public sitemap/profile links, and marketplace offer rows where applicable.
- [x] Run focused design-system, Discovery, Checkout, and Marketplace tests plus repository typecheck/static checks for touched contracts.

## Documentation To Promote

- Update `packages/design-system/MARKETPLACE_SYSTEM.md` so account profile and account reputation language is role-neutral and does not reference seller profiles as the canonical pattern.
- No ADR needed: this is an alignment of existing Account/Reputation ownership and an existing design-system contract, not a new hard-to-reverse architecture decision.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
