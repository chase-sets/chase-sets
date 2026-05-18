# Buy Now Product Account Components

## Intent

Update the item detail buy-now and sell-now workflow summaries to render product selections and transaction-party account attribution through the design-system product and account components instead of route-local custom text.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-buy-now-product-account-components`
- Branch: `codex/buy-now-product-account-components`
- Sandbox id: `38de2d14`
- Dependency setup status: complete; `pnpm run deps:install` and `pnpm run sandbox:doctor` succeeded
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Discovery owns the item-detail page and its presentation model. Evidence: `bounded-contexts/discovery/README.md` owns browse/search/detail presentation and `context.json` maps `items/:id` to Discovery.
- Marketplace owns listings/offers and account-level marketplace facts consumed by Discovery projections. Evidence: `bounded-contexts/marketplace/README.md` owns listing and offer workflows before an order exists.
- The design system is the canonical source of truth for product/account UI primitives. Evidence: `packages/design-system/src/components/ui/marketplace.tsx` exports `ProductOptions` and `AccountReputationSummary`.

## Resolved Decisions

- Keep behavior in `bounded-contexts/discovery/routes/item-detail.tsx`; this is a rendering change in the existing item-detail route composition.
- Replace `ProductCriteriaText` usage in the buy-now purchase summary with `ProductOptions` so the route does not duplicate product option formatting.
- Render selected listing seller attribution with `AccountReputationSummary`, using projected seller slug, rating, and review count where available.
- Render sell-now offer buyer attribution with `AccountReputationSummary`, using projected buyer slug, rating, and review count where available.
- Preserve existing form fields, actions, labels, marketplace facts, and checkout/offer submission behavior.

## Open Questions

None.

## Implementation Checklist

- [x] Install dependencies in the worktree and run `pnpm run sandbox:doctor`.
- [x] Update item-detail route imports and remove custom product criteria rendering if no longer used.
- [x] Expand selected listing and selected offer prop shapes only for existing projected account fields.
- [x] Update buy-now summary assertions to validate product/account component output.
- [x] Update sell-now summary assertions to validate buyer account component output.
- [x] Run focused tests for the item-detail commerce panel.
- [x] Run workspace typecheck.

## Documentation To Promote

None expected. This uses existing Discovery ownership and design-system components without changing durable terms or context structure.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
