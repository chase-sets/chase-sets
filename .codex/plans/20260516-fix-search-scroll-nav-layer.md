# Fix Search Scroll Nav Layer

## Intent

Prevent search page content from painting above the sticky marketplace top navigation while scrolling.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260516-fix-search-scroll-nav-layer`
- Branch: `codex/fix-search-scroll-nav-layer`
- Sandbox id: `85f6fd16`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none found

## Owning Contexts

- Discovery owns browse and search page behavior, read models, filter state, and search result presentation.
- The design system owns shared shell, top navigation, cards, and layout stacking patterns.
- Marketplace deployable remains a thin composition root that wires Discovery into the marketplace shell.

## Resolved Decisions

- Fix the issue in the design-system marketplace shell instead of the Discovery search slice because the symptom comes from shared shell stacking, not search query behavior.
- Keep `ListingCard` local layers intact. Its internal `z-10`, `z-20`, and `z-30` layers are used for full-card links, content, and actions.
- Add a stacking boundary around shell main content so page-local z-index layers cannot escape above sticky navigation siblings.
- Do not raise every sticky layer above dropdowns, drawers, or popovers. Top navigation should remain on the sticky layer while content is isolated below it.

## Implementation Checklist

- [x] Add a design-system stacking boundary to `MarketplaceShell` main content.
- [x] Add a regression assertion that the marketplace shell renders main content as an isolated lower layer below sticky navigation.
- [x] Run design-system tests after worktree dependency setup.
- [x] Browser-check the seeded marketplace search page after scrolling.

## Documentation To Promote

- No durable architecture or glossary documentation is needed. This is a design-system implementation bug fix using existing layer tokens.

## Goal Completion Criteria

- Search content and listing-card local layers cannot paint above the top nav while scrolling.
- Design-system regression test passes.
- Worktree plan remains with the implementation.

## Verification

- `pnpm run sandbox:doctor`
- `pnpm --filter @chase-sets/design-system run test` passed: 2 files, 89 tests.
- `pnpm --filter @chase-sets/design-system run typecheck`
- Browser checked `http://localhost:9903/search` with seeded cards after scroll: `main#main-content` renders `relative z-0`, top nav renders `z-sticky`, 10 listing cards were present, and the Browse top-nav link remained visible after scrolling.
