# Account Role Language

## Intent

Clarify product and domain guidance so Chase Sets treats every account as a marketplace participant that can both buy and sell. Buyer and seller language should describe transaction roles only, not account identity, account classes, or separate account-profile endpoints.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-account-role-language`
- Branch: `codex/account-role-language`
- Sandbox id: `732ae6a6`
- Dependency setup status: completed by `pnpm run test:structure`
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Identity owns `Account`, the root identity for marketplace participation.
- Ordering owns `Buyer` and `Seller` as transaction roles on orders, purchases, and sales.
- Marketplace owns `Listing`, `Offer`, and listing/offer workflows before an order exists.
- Commercial Terms owns marketplace sales fee policy for the selling account's transaction economics.
- Payments owns checkout fees and payment/refund execution for the purchasing account's payment flow.
- Settlement owns wallet, payout readiness, and provider onboarding capability for accounts receiving settlement.

## Resolved Decisions

- All accounts are buying and selling capable by default at the product-language level.
- Buyer and Seller must not become account types, account profile classes, or endpoint families that imply separate identities.
- Product and UX guidance should use `Account`, `listing owner`, `inventory owner`, `purchasing account`, `selling account`, or `payout-ready account` outside transaction-specific surfaces.
- Transaction-specific read models and endpoints may keep natural role language: `Purchase`, `Sale`, buyer account, seller account, buyer-paid share, seller net, seller-confirmed fee, and buyer-protection copy.
- Selling enablement gates such as terms acceptance, Stripe onboarding, payout readiness, tax identity, or verification are capabilities/permissions on an account, not proof that a distinct seller account exists.
- Avoid creating endpoints such as `seller account profile`. Public or marketplace-visible profile/trust surfaces should be account profile/reputation surfaces with contextual role labels where needed.

## Repo Evidence

- `bounded-contexts/README.md` already states Buyer and Seller are transaction roles played by Account, not separate root entities or capability classes.
- `docs/GLOSSARY.md` already has cross-context account role language, but product/API/design guidance still contains older phrasing that can imply buyer/seller cohorts or seller-specific profile surfaces.
- `bounded-contexts/identity/README.md` says buying and selling are available to active accounts by default and Buyer/Seller are not account capability classes.
- `bounded-contexts/identity/GLOSSARY.md` says buying and selling are not account capability classes.
- `bounded-contexts/marketplace/README.md` previously said Buyer and Seller are account roles; this plan tightens that to transaction roles played by accounts to avoid conflict with Identity role/permission language.
- `bounded-contexts/ordering/GLOSSARY.md` correctly uses Purchase and Sale as role-specific projections of an Order.
- `docs/api/marketplace.openapi.json` still described the API as a buyer/seller experience and called the listing availability overlay a seller account overlay; that was product guidance drift because those endpoints are account-scoped listing capability surfaces.
- `docs/runbooks/money-operations.md` used seller-account phrasing for Stripe Connect and payout readiness; this was converted to payout capability language while leaving sale economics intact.

## Open Questions

None. The user supplied the product decision directly.

## Implementation Checklist

- [x] Update product brief wording so target users and value props describe accounts and transaction posture, not separate buyer/seller identities.
- [x] Update API guidance so account-scoped routes are not described as buyer/seller account endpoints unless the route is a transaction projection.
- [x] Update design-system marketplace guidance to replace seller-profile language with account profile/reputation language.
- [x] Keep transaction, economics, payout, fee, refund, and protection terms where they describe the account's role in a concrete transaction.
- [x] Verify remaining guidance references distinguish account identity from transaction roles.

## Verification

- `git diff --check`
- `pnpm run test:structure`
- `pnpm run sandbox:doctor`

## Documentation To Promote

- `docs/PRODUCT.md`
- `docs/GLOSSARY.md`
- `docs/api/marketplace-api.md`
- `docs/api/marketplace.openapi.json`
- `bounded-contexts/marketplace/README.md`
- `bounded-contexts/insights/README.md`
- `packages/design-system/MARKETPLACE_SYSTEM.md`
- `docs/runbooks/money-operations.md`
- `docs/runbooks/ucp-agent-commerce.md`

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
