# Catalog Fallback Images

## Intent

Catalog Items need an explicit fallback image configuration so common card backs can be reused as loading imagery across search, discovery detail, catalog admin detail, and checkout thumbnails without hiding front images once they load. The same configuration must also support permanent fallback imagery, such as a card back that remains selectable in the item detail gallery, and loading-only imagery, such as a sealed-product placeholder that should not become a permanent catalog image.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-catalog-fallback-images`
- Branch: `codex/catalog-fallback-images`
- Base: current `main` worktree HEAD `db6d5a27` because no alternate base was named.
- Rebase note: PR branch was later rebased onto `origin/main` after PR 131 reported a dirty merge state; conflict resolution preserved main's `product_asset_sets` optimized front-image pipeline and layered Catalog Item Image Fallback alongside it.
- Sandbox id: `72117f6a`
- Dependency setup: `pnpm run deps:install` completed.
- Sandbox doctor: `pnpm run sandbox:doctor` completed; admin web `http://localhost:8902`, marketplace `http://localhost:8903`, platform API `http://localhost:8912`.
- Setup blockers: none.

## Owning Contexts

- Catalog owns the canonical image fallback configuration because Catalog owns the canonical Catalog Item truth and image URLs.
- Discovery consumes Catalog facts into search and item detail projections, then decides how those facts are presented in browse/detail.
- Checkout stores cart-line item image snapshots; it should consume Discovery-selected thumbnail and loading fallback snapshots so carts can use the shared card-back loader without recomputing Catalog rules.
- Design System owns reusable loading/fallback image rendering primitives used by ListingCard, ImageGallery, and cart line items.

## Resolved Decisions

- Canonical term: `Catalog Item Image Fallback`.
- Storage/API field name: `image_fallback`.
- Domain shape: `{ url, alt, usage, variants }`.
- `usage = "permanent"` means the fallback is an actual item image. It can be used when there is no front image, on image errors, and as a selectable detail-gallery image.
- `usage = "loading-only"` means the fallback can be shown while the primary image is loading, but it is not appended to selectable image galleries and is not treated as a replacement when an item has no permanent image.
- `variants` carries optimized image URLs by size and density, so fallback imagery can use the same responsive-image selection as front imagery without encoding product-line rules in UI code.
- Product-line differences are represented through Catalog Item fallback configuration. English Pokemon cards, Japanese Pokemon cards, and sealed products can point at different shared Catalog-owned fallback assets while still using one canonical model.
- Existing `image_urls` remain the ordered front/permanent image list for compatibility. The fallback is separate so common card backs do not become the leading thumbnail unless configured as permanent imagery.

## Open Questions

- None blocking. The initial implementation uses per-Catalog Item configuration and leaves any future product-line-level defaults to a later Catalog authoring workflow if duplication becomes painful.

## Implementation Checklist

- Completed: Add Catalog domain command/event/state for setting and clearing `image_fallback`.
- Completed: Persist `image_fallback` in Catalog item and admin read models.
- Completed: Project `image_fallback` into Discovery search and item detail read models.
- Completed: Surface `image_fallback` through Catalog admin contracts and controls.
- Completed: Update Discovery search/detail rendering to use loading-only vs permanent fallback behavior.
- Completed: Keep permanent fallback selectable in the item detail gallery.
- Completed: Pass fallback loading-image snapshots into Checkout cart thumbnails through the Discovery add-to-cart flow while preserving the permanent image snapshot separately.
- Completed: Extend design-system image primitives with loading and responsive fallback sources.
- Completed: Add focused domain and UI tests.
- Completed: Run targeted typecheck/tests and broader static checks.

## Documentation To Promote

- Completed: Added Catalog glossary wording for Catalog Item Image Fallback.
- Completed: Added `bounded-contexts/catalog/docs/catalog-item-imagery.md`.
- Completed: Added the Catalog imagery note to `docs/README.md`.

## Verification

- Passed: `pnpm run deps:install`
- Passed: `pnpm run sandbox:doctor`
- Passed: `pnpm --filter @chase-sets/catalog run test -- features/catalog-items/domain/domain.test.ts`
- Passed: `pnpm --filter @chase-sets/catalog run test -- features/catalog-items/ui/catalog-item-detail-page.test.tsx features/catalog-items/domain/domain.test.ts`
- Passed: `pnpm --filter @chase-sets/discovery run test -- tests/item-detail-commerce-panel.test.tsx features/search/ui/search-page.test.tsx tests/item-detail-offer-matches.test.ts`
- Passed: `pnpm --filter @chase-sets/design-system run test -- src/__tests__/design-system-parity.test.tsx`
- Passed: `pnpm --filter @chase-sets/checkout run test -- features/cart/ui/cart-page.test.tsx`
- Passed: `pnpm run check:localization`
- Passed: `pnpm run check:structure`
- Passed: `pnpm run verify:typecheck`
- Passed: `git diff --check`
- Passed after rebase conflict resolution: Catalog, Discovery, Checkout, design-system parity, localization, structure, full typecheck, and `git diff --check`.
- CI follow-up: first PR CI run failed Unit Tests in Discovery because `item-detail-buy-now-action.test.ts` still expected the pre-fallback cart-line shape. The test expectations were updated, and `pnpm --filter @chase-sets/discovery run test` passed locally.
- Blocked: local visual browser smoke. `pnpm run dev:marketplace-full` started sandbox Postgres but `@chase-sets/app-platform-api` bootstrap exited with `3221226505` before the apps were browserable.
- Completed cleanup after blocked visual check: `pnpm run dev:down`.

## Goal Completion Criteria

- Implementation lives in this worktree and branch.
- Catalog domain, read models, admin UI, Discovery projections/UI, Checkout thumbnails, and design-system image primitives support the new fallback model.
- Durable documentation is committed with the retained plan.
- Automated verification covers domain behavior, projection behavior, UI rendering, and type safety.
- If UI visual changes are substantial, verify admin and marketplace surfaces at desktop and mobile widths.
- Submit a PR, wait for passing CI, merge, verify preview cleanup, verify staging, and verify production once the merge reaches `main`.
