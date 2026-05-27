# Search Result Cards

## Intent

Simplify Discovery search result cards so they show product identity, meaningful price when supply exists, and direct buy/sell/watch actions without repeating market status, seller trust, supply, or availability copy.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260527-search-result-cards`
- Branch: `codex/search-result-cards`
- Sandbox id: `740dcbaa`
- Dependency setup: `pnpm run deps:install` completed
- pnpm store: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Discovery owns search results and can reshape marketplace facts for browse presentation.
- Catalog owns product image asset generation and fallback semantics.
- Design System owns `ListingCard` layout and component hierarchy.

## Resolved Decisions

- Search result cards should not render market-only filler such as `Market open`, `Supply wanted`, `Offers open`, or `Offer or list yours`.
- Active supply cards should show the lowest price because it directly helps compare products.
- Listing count, available quantity, verified seller, verified supply, and available-now copy are redundant in this compact browse context and should not appear on search cards.
- Desktop search result cards should return to a side-by-side layout with a larger media column.
- Subtitles should wrap to preserve variant-identifying product facts.
- Loading/back preview should only be used when the item fallback is a permanent product back, not for loading-only sealed-product placeholders.
- Search-card asset variants should be generated at a larger width to stay crisp at the larger displayed size.

## Implementation Checklist

- [x] Update Discovery search-card copy inputs.
- [x] Update `ListingCard` search-result layout, optional price handling, subtitle wrapping, and permanent-fallback preview behavior.
- [x] Increase search-card generated asset specs and related tests.
- [x] Verify focused tests.
- [x] Run local marketplace and visually inspect desktop/mobile search results.

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
