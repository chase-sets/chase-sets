# Wallet Navigation

## Intent

Make an account's Wallet immediately discoverable without requiring the current path of Sell -> Payouts -> View Wallet.

The UX concern is that Wallet is account-owned financial state from the user's perspective, but the current navigation exposes only Payouts inside the Sell group and hides Wallet as a secondary action on the Payouts page.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260513-wallet-navigation`
- Branch: `codex/wallet-navigation`
- Base: current source repo HEAD `4f492f63 Clarify plan skill worktree setup`
- Sandbox id: `3a83baa7`
- Dependency setup: `pnpm run deps:install` completed.
- Sandbox status: `pnpm run sandbox:doctor` completed.
- Setup caveat: local Node is `v26.1.0`; repo engine asks for Node `24.x`. Commands completed with warnings.

## Owning Contexts

- Settlement owns Wallet, Balance, Ledger Entry, Payout, Payout Readiness, and the `/account/settlement` and `/account/payouts` marketplace routes.
- Identity owns Account and the `/account` profile route. Identity glossary says accounts own wallets and balances, but Identity must not own wallet behavior.
- Marketplace deployable composes marketplace navigation in `deployables/marketplace/app/host.ts`; it should remain a thin composition root.
- The likely behavior owner is Settlement for any durable wallet/payout nav contribution, with the marketplace host only grouping or ordering contributed nav items.

## Resolved Decisions

- Use "Wallet" as the canonical user-facing destination for balance and ledger visibility. Settlement glossary defines Wallet as the balance container for an account within the marketplace ledger.
- Use "Account" for the commercial owner in product/domain language. The cross-context glossary says Account should be used for wallet, navigation, and account settings; Buyer and Seller are transaction roles only.
- Do not move wallet behavior into Identity or Marketplace. Settlement remains the owner of financial read models, route loaders, permissions, and UI contracts.
- Treat the existing Sell -> Payouts -> View Wallet path as insufficient because it hides wallet state behind seller payout workflow language.
- Product decision: Wallet should become the primary account-money navigation destination. Payouts should remain available as the payout-request/history workflow, but should no longer be the only visible account-money entry point.

## Repo Evidence

- `bounded-contexts/settlement/context.json` contributes routes for `/account/settlement`, `/account/payouts`, `/account/payouts/:payoutId`, `/account/money-health`, and `/account/payout-operations`, but `shellContributions` is currently empty.
- `bounded-contexts/settlement/routes/marketplace/account-settlement.tsx` requires `payouts.view` and renders `SettlementWalletPage`.
- `bounded-contexts/settlement/features/wallets/ui/wallet-page.tsx` titles the page "Wallet" and links to `/account/payouts`.
- `bounded-contexts/settlement/features/payouts/ui/payout-list-page.tsx` titles the page "Payouts" and links to `/account/settlement` with "View Wallet".
- `deployables/marketplace/app/host.ts` synthesizes a `payouts` nav item for actors with `payouts.view`, gives it wallet icon, and groups it under the `Sell` / `selling-workspace` nav group.
- `deployables/marketplace/app/routes/layout.tsx` already treats `/account/payouts` and `/account/settlement` as active key `payouts`.
- `docs/GLOSSARY.md` says to use Account for wallet, inventory ownership, listings, navigation, and account settings, and to use Seller only for transaction endpoints.

## Open Questions

- None currently blocking.

## Implementation Checklist

- Add a Settlement-owned shell contribution for Wallet or account money navigation instead of relying only on host-synthetic Payouts.
- Update marketplace host grouping so Wallet is discoverable from Account navigation and not only from Sell.
- Preserve quick access to Payouts for accounts with payout permissions.
- Prefer `wallet` as the nav key and `/account/settlement` as the visible account-money href.
- Keep `/account/payouts` as a Settlement-owned Payouts route linked from Wallet and available as an account-money child/action where the navigation supports it.
- Keep route ownership in Settlement and deployable composition in the marketplace host.
- Update active-key logic and tests for `/account/settlement` and `/account/payouts`.
- Verify desktop top navigation and mobile bottom navigation flows.
- Verify no custom design-system overrides are introduced.

## Documentation To Promote

- Added `bounded-contexts/settlement/docs/account-money-navigation.md` to explain the Wallet-primary navigation rule.
- Updated `docs/README.md` to include the Settlement owner-owned navigation doc.

## Verification

- `pnpm --filter @chase-sets/app-marketplace-web exec vitest run --config ./vitest.config.ts app/routes/layout.test.tsx`
- `pnpm --filter @chase-sets/settlement run test:fast`
- `pnpm --filter @chase-sets/app-marketplace-web run test`
- `pnpm --filter @chase-sets/app-marketplace-web run typecheck`
- `pnpm --filter @chase-sets/settlement run typecheck`
- `pnpm run check:structure`
- `pnpm run check:localization`
- `pnpm run verify:metadata`
- `pnpm run verify:typecheck`
- `pnpm run verify:static`
- `pnpm run verify:build`
- `git diff --check`
- Local marketplace stack was started at `http://localhost:7553` after `pnpm run dev:bootstrap`.
- Browser visual verification covered signed-out desktop and mobile navigation. Authenticated desktop/mobile Wallet and Payouts navigation is covered by layout tests; the in-app browser could not complete sign-in because email input automation failed on the local sign-in form.

## Goal Completion Criteria

The implementation goal must:

- Use this worktree and branch.
- Implement the accepted wallet navigation decision without moving Settlement behavior into Identity or Marketplace.
- Promote any durable documentation needed to explain the Wallet/Payout navigation rule.
- Keep this plan committed with the implementation.
- Run focused automated checks for affected navigation, Settlement UI, and marketplace host behavior.
- Run relevant typecheck/tests when feasible.
- Perform desktop and mobile visual verification of the marketplace navigation and Wallet/Payout routes.
- Submit a PR, get CI passing, merge the PR, and confirm the staging deploy exposes Wallet without the Sell -> Payouts -> View Wallet detour.
