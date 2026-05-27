# Search Result Card Density

## Intent

Restore the visible card-back preview for two-sided card search results, reduce wasted horizontal space inside each search result card, and allow wider desktop result grids to use more than two columns.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260527-search-result-card-density`
- Branch: `codex/search-result-card-density`
- Sandbox id: `2cf02f40`
- Dependency setup: `pnpm run deps:install` completed successfully.
- pnpm store: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox doctor: passed.
- Setup blockers: none.

## Owning Contexts

- Discovery owns search result composition and grid density.
- Catalog owns generated product image asset roles and sizes; no new asset size appears necessary because the current `search-card` role is already `224w` and `448w`.
- Design System owns `ListingCard`, the reusable search-result card layout, media treatment, and density rules.

## Resolved Decisions

- Keep search results side-by-side at desktop, but allow a third desktop column at the widest breakpoint instead of capping at two columns.
- Restore the back-preview effect as a design-system behavior for search-result cards when a front image and a permanent fallback image are both present.
- Do not show the back preview for loading-only fallbacks, which keeps sealed products and other non-card products from showing a card back.
- Tighten the media-to-content spacing inside search-result cards by reducing facing padding, while keeping stable media column dimensions so image size does not jitter.
- Keep the current `search-card` generated asset size unless visual verification shows it is being stretched beyond the `224w/448w` crisp source contract.

## Implementation Checklist

- Update `ListingCard` search-result media layering so permanent fallbacks remain visible behind front card images.
- Tighten `ListingCard` search-result media/content spacing.
- Update Discovery search grid columns to allow more than two desktop columns.
- Update focused tests for fallback preview behavior, sealed-product exclusion, image sizing, and grid density.
- Run focused package tests plus typecheck/format/localization checks.
- Visually verify desktop and mobile search result cards.

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
