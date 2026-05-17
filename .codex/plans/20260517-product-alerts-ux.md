# Product Alerts UX

## Intent

Reduce the space taken by `Watch for listings` and `Watch for offers` on the Discovery Detail Page while preserving a clear path to create a Product Alert for the selected Product.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-product-alerts-ux`
- Branch: `codex/product-alerts-ux`
- Sandbox id: `eeefe25a`
- Dependency setup status: complete; `pnpm run deps:install` succeeded
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: `pnpm run dev:marketplace` could not reach browser verification because `@chase-sets/app-platform-worker` bootstrap failed with exit status `3221226505`; sandbox was stopped with `pnpm run dev:down`.

## Owning Contexts

- Discovery owns the Detail Page and Product Alert creation flow.
- Catalog owns source Catalog Product identity referenced by alerts.
- Marketplace owns Listing and Offer lifecycle facts that can match alerts.
- Notifications owns delivery settings and notification-center policy, but this change does not move alert creation out of Discovery.

## Resolved Decisions

- Keep Product Alert creation on the Discovery Detail Page because the alert depends on selected Product options, market side, and price threshold.
- Treat Product Alerts as a secondary affordance under the primary commerce action, not a peer card. This follows the marketplace design-system hierarchy that secondary watchlist/watch affordances should not compete visually with the primary action.
- Use the design system `ProgressiveDisclosure` pattern for the alert setup. The collapsed trigger should summarize the intent and selected Product; the expanded body should contain the threshold field and submit button.
- Keep separate listing and offer alert entry points because their thresholds have opposite meanings: listing alerts match at or below a maximum price, offer alerts match at or above a minimum price.
- No domain, API, event, or read-model changes are needed. This is a Discovery route UI composition change only.

## Implementation Checklist

- Update `bounded-contexts/discovery/routes/item-detail.tsx` to render Product Alert creation as compact progressive disclosure. Completed.
- Keep hidden form fields and existing `create-product-alert` action contract unchanged. Completed.
- Preserve disabled behavior when no resolved `productId` exists. Completed.
- Verify TypeScript for the Discovery workspace. Completed with `pnpm exec tsc -p ./tsconfig.json --noEmit`.
- Run focused tests/checks that are available after worktree dependency setup. Completed with `pnpm --filter @chase-sets/discovery test`.

## Verification

- `pnpm run deps:install`: passed.
- `pnpm run sandbox:doctor`: passed for sandbox `eeefe25a`.
- `pnpm exec tsc -p ./tsconfig.json --noEmit`: passed.
- `pnpm --filter @chase-sets/discovery test`: passed, 16 files passed, 1 skipped; 81 tests passed, 4 skipped.
- Pre-PR recheck: `pnpm run deps:install`, `pnpm run sandbox:doctor`, `pnpm exec tsc -p ./tsconfig.json --noEmit`, and `pnpm --filter @chase-sets/discovery test` passed again.
- Browser verification: blocked because `pnpm run dev:marketplace` failed during `@chase-sets/app-platform-worker` bootstrap with exit status `3221226505` before Marketplace opened on port `9103`.

## Documentation To Promote

- No durable docs are required unless implementation uncovers a reusable design-system Product Alert pattern. The existing Discovery Product Alerts docs already define ownership and management boundaries.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
