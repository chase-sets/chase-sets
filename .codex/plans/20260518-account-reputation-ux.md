# Account Reputation UX Follow-Up

## Intent

Fix the shipped account reputation standard view so it works as a compact, reusable marketplace attribution primitive instead of a boxed trust card inside dense listing rows.

The user feedback to address:

- Do not list the account/seller name twice on listing rows.
- Do not render a redundant `View feedback` action when the account name already links to the account feedback/profile destination.
- Sweep other surfaces that still show account names outside the standard account+feedback primitive.
- Remove the unexplained account icon until it has real product meaning.
- Make the component blend into its host surface by default; add framing only when a caller explicitly needs a standalone module.
- Replace long `No feedback yet` copy in dense use with a compact state comparable to rating text.
- Only the account name should be clickable, not the entire component.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-account-reputation-ux`
- Branch: `codex/account-reputation-ux`
- Base: `origin/main` at creation
- Sandbox id: `3fab1f95`
- Dependency setup: complete via `node .\scripts\worktree-deps.mjs install`
- pnpm store: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox doctor: passed

## Owning Contexts

- Design System owns `AccountReputationSummary` and `ListingCard` presentation patterns.
- Discovery owns public browse/listing/detail presentation that consumes projected account and reputation facts.
- Marketplace owns account listing and offer-management surfaces that expose account attribution before order creation.
- Checkout owns cart and checkout purchase-intent surfaces where seller account attribution appears.
- Reputation owns feedback facts, but this change does not alter reputation data ownership.

## Resolved Decisions

- `AccountReputationSummary` stays the canonical account+feedback primitive, but becomes inline by default: no icon, no border, no background, and no component-wide link.
- The account name is the only clickable element when `href` is provided. Rating/feedback text remains plain text.
- The empty feedback state defaults to compact `New`, with accessible text available through `title`/labeling where needed.
- `feedbackLabel` / separate `View feedback` action is removed from the component contract for default use; account profile/feedback navigation is represented by the linked account name.
- Dense listing rows should show account attribution only once, in the seller/account column. Trust/rating columns may show rating-only content but must not repeat the account name.
- Standalone trust/account modules may opt into a framed container if a future surface needs it; dense rows should use the unframed inline default.

## Implementation Checklist

- Update `AccountReputationSummary` API and markup.
- Update `ListingCard` so listing rows do not duplicate seller/account names in trust content.
- Sweep Discovery item detail/listing/account surfaces for redundant feedback actions and duplicate account names.
- Sweep Checkout cart/session and Marketplace offer/listing management surfaces using `AccountReputationSummary`.
- Update design-system and bounded-context tests for compact empty state and account-name-only link.
- Update design-system docs for compact inline attribution rules.

## Documentation To Promote

- `packages/design-system/MARKETPLACE_SYSTEM.md` should state the account row is compact, inline, and only the account name links.

## Implementation Notes

- `AccountReputationSummary` is now inline by default, with a `framed` opt-in for future standalone modules.
- Dense Discovery listing rows now place account name plus feedback in one seller/account cell and remove the redundant trust column.
- Compact selected-listing summaries now show price, availability, and product details without repeating the account name.
- Checkout and Marketplace offer surfaces rely on the default compact `New` state instead of long seller/buyer-specific empty copy.
- `ListingCard` only uses account reputation markup when it has actual account navigation or reputation data; aggregate marketplace supply labels stay plain.

## Verification

- `pnpm --filter @chase-sets/design-system run test`
- `pnpm --filter @chase-sets/discovery run test -- item-detail-commerce-panel.test.tsx`
- `pnpm --filter @chase-sets/marketplace run test -- offer-match-list-page.test.tsx`
- `pnpm --filter @chase-sets/checkout run test -- cart-page.test.tsx checkout-page.test.tsx`
- `pnpm --filter @chase-sets/design-system run typecheck`
- `pnpm run check:localization`
- `pnpm run check:structure`
- `pnpm run check:no-any`
- `pnpm exec tsc -p ./tsconfig.json --noEmit`
- `node ./scripts/run-workspaces.mjs typecheck --concurrency=4`
- Playwright smoke check against `http://localhost:8653/search?q=charizard` and the seeded Charizard item detail verified no redundant `View feedback`, no account icon/card chrome, compact `New`, and account-name-only profile links in listing rows.

Note: the aggregate `pnpm run typecheck` command timed out without diagnostics in this worktree, so the same constituent commands were run independently and passed.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks, unless the user explicitly waives review.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
