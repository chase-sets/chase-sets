# Commerce Summary Product Quantity

## Intent

Tighten the Discovery item-detail buy-now summary so price, account, product, and available quantity scan cleanly in the collapsed workflow panel. Product selection and quantity should use the more compact listing-row pattern instead of stacking account, quantity, and product as competing lines.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260519-commerce-summary-product-qty`
- Branch: `codex/commerce-summary-product-qty`
- Sandbox id: `11a411ec`
- Dependency setup status: complete; `pnpm run deps:install` and `pnpm run sandbox:doctor` succeeded
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Discovery owns the item-detail presentation model and `items/:id` route.
- Marketplace owns Listing and available quantity facts projected into Discovery.
- The design system owns reusable `ProductOptions` and `AccountReputationSummary` components; this change should compose those instead of creating custom product/account primitives.

## Resolved Decisions

- Keep the change in `bounded-contexts/discovery/routes/item-detail.tsx`; this is a Discovery item-detail rendering refinement.
- Preserve Checkout and Marketplace behavior, hidden fields, action buttons, and selected listing facts.
- Move the buy-now summary to a clearer hierarchy: price first, account attribution second, then a compact product-plus-quantity row.
- Keep the product selection first in that compact row and quantity second, matching the listing row’s scan order while still making quantity visible.
- No durable terminology or context-structure documentation changes are needed.

## Open Questions

None.

## Implementation Checklist

- [x] Install dependencies in the worktree and run `pnpm run sandbox:doctor`.
- [x] Refactor buy-now summary layout to separate seller attribution from product and quantity.
- [x] Add/update focused tests proving product and quantity render together in the compact summary.
- [x] Run focused Discovery item-detail commerce tests.
- [x] Run typecheck or the narrowest sufficient static verification after the UI change.

## Verification Notes

- `pnpm --filter @chase-sets/discovery exec vitest run --config ./tests/vitest.config.mjs tests/item-detail-commerce-panel.test.tsx` passed.
- `pnpm run verify:typecheck` passed.
- After rebasing onto `origin/main` at `046e8074`, the same focused Discovery commerce panel suite passed again.
- After rebasing onto `origin/main` at `046e8074`, `pnpm run verify:typecheck` passed again.
- Live marketplace dev-server visual QA was attempted, but the sandbox Postgres port `9420` was already allocated locally. The failed compose attempt was cleaned up with `pnpm run dev:down`.

## Documentation To Promote

None expected.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
