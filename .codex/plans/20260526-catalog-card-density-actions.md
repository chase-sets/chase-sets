# Catalog Card Density And Actions

## Intent

Address the staging review findings for the new Discovery search product-card layout with a fresh PR. Search results should stay crisp, scannable, and efficient for repeated browse work across marketplace categories, especially low-value cards where discovery speed and clear buy/sell intent matter.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-catalog-card-density-actions`
- Branch: `codex/catalog-card-density-actions`
- Base: `origin/main` at `24100fad Make catalog bulk jobs deployment-resilient`
- Sandbox id: `78bac0a2`
- Dependency setup: complete via `pnpm run deps:install`
- pnpm store: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Discovery owns the search result presentation, browse behavior, filters, and product-detail entry points.
- The design system owns reusable marketplace card primitives and the canonical action hierarchy guidance.
- Marketplace remains the owner of listing and offer lifecycle truth; this change should only reshape Discovery's projected browse presentation and route intents.
- Deployables remain thin composition roots and should not receive route-local card styling overrides.

## Findings To Address

- P1: Three-column result grids make each two-column card too narrow, so product names, metadata, and controls become cramped.
- P1: The primary action hierarchy is unclear because Buy, Sell, Watch, and offer/list language compete inside the same small action row.
- P2: Status badges visually collide with product media when they sit near or over the image plane.
- P2: Repeated default metadata creates noise before the title and slows scanning.
- P2: The card is too tall and action-heavy for discovery, creating vertical drag despite a wide grid.

## Resolved Decisions

- Keep this as a Discovery search follow-up using the design-system `ListingCard` search-result pattern, not a deployable override.
- Prefer a two-column desktop grid for search results until the card pattern supports a truly compact three-column presentation. This gives the card enough width for product name, market state, and one clear primary action.
- Make one visible dominant action per card based on market state: Buy when active listings exist, Sell when supply is wanted. Watch should be secondary and visually quieter.
- Avoid rendering all product intents as equal small buttons in the card. Secondary intents should use progressive disclosure or compact secondary affordances so repeated browsing remains efficient.
- Keep badges in the content plane and away from the image top edge. If a search-result status label is needed, it should read as part of the market summary rather than an image sticker.
- Keep default language and common blueprint metadata out of every card. Show only discriminating metadata, such as non-default language or a compact product identity line when it helps distinguish otherwise similar results.
- Preserve the responsive image source contract from the previous card-image fix. Search-card media should continue to render from the catalog asset role and should not stretch beyond the role's crisp CSS slot.

## Stress Test

- Normal browse: a buyer scanning a common Pokemon set should see more title width, less repeated text, and a clear Buy action when supply exists.
- Supply wanted: a seller should see Sell as the clear primary action without the supply badge covering card art.
- Stale market projection: cards with no listings should remain honest with `Market open` and should not imply immediate purchasability.
- Mixed categories: long comic, sneaker, and memorabilia names should have enough card width to avoid excessive wrapping.
- Mobile: the card must stay single-column friendly and avoid tiny tap targets.
- Low-value cards: action density must not make bulk discovery fiddly; the card should favor scan speed over exposing every possible workflow inline.

## Implementation Checklist

- Completed: Discovery search result grid breakpoints now cap browse cards at two columns on desktop instead of restoring a cramped three-column layout.
- Completed: The design-system search-result `ListingCard` uses a smaller compact product media slot, tighter search-result typography, and a one-primary-action row.
- Completed: Discovery search cards render one full-width primary Buy or Sell action; the opposite trade-side intent and Watch render as quieter secondary actions.
- Completed: Search result cards no longer render `Supply wanted` or `Available now` as promotion badges or card-top status text. Market state remains visible through price, listing detail, seller signal, trust badge, fulfillment, and the selected primary action.
- Completed: Tests cover grid/card layout, badge removal, metadata suppression, image source sizing, and accessible action labels.
- Completed: `packages/design-system/MARKETPLACE_SYSTEM.md` now documents one dominant search-result action and secondary trade/watch intents.
- Completed: Visual verification against `http://localhost:7703/search` showed two 532px desktop columns, a 104px rendered compact product image, no promotion badge, and the first market-only card reduced from 292px to 276px after removing the card-top status line.
- Pending: run broader test/build verification, commit, push, and open the PR.

## Verification

- Passed: `pnpm run deps:install`
- Passed: `pnpm run sandbox:doctor`
- Passed: `pnpm --filter @chase-sets/design-system run test`
- Passed: `pnpm --filter @chase-sets/discovery run test -- search-page`
- Passed: `pnpm --filter @chase-sets/app-marketplace-web run test -- search`
- Passed: `pnpm --filter @chase-sets/design-system run typecheck`
- Passed: `pnpm run verify:static` with existing unrelated Discovery single-slice support warnings.
- Passed: `pnpm run verify:typecheck`
- Passed: `pnpm run verify:test`
- Passed: `pnpm run verify:build` with existing bundle-size warnings.
- Passed: Visual browser check at `http://localhost:7703/search` on desktop `1440x1100` and mobile `390x900`.
- Commit the retained plan with the implementation, push `codex/catalog-card-density-actions`, and open a new PR.

## Documentation To Promote

- Promote any changed marketplace-card action hierarchy or search-result density rule to `packages/design-system/MARKETPLACE_SYSTEM.md`.
- No bounded-context glossary changes are expected because the existing Discovery terms `Search Result`, `Result Set`, and `Detail Page` still fit.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
