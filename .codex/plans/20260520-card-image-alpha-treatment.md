# Card Image Alpha Treatment

## Intent

Product imagery should render as the collectible itself, not as a rectangular UI box. Pokemon images with transparent rounded corners should keep their alpha shape in both light and dark mode, while older provider images with unnecessary top/bottom whitespace should be normalized before display. Search results and item detail should use one canonical design-system media treatment instead of separate square, rounded, bordered, or shadowed wrappers.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-card-image-alpha-treatment`
- Branch: `codex/card-image-alpha-treatment`
- Created from: source repo `main` at `15a5623f`
- Rebased onto: `origin/main` at `6939e99c` after PR conflict detection.
- Sandbox id: `8c4add4b`
- Dependency setup: `node ./scripts/worktree-deps.mjs install` completed.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox setup: `pnpm run sandbox:doctor` completed.
- Sandbox ports: marketplace `http://localhost:8953`, platform API `http://localhost:8962`, dev portal `http://localhost:8950`
- Setup blockers: none.

## Owning Contexts

- Catalog owns canonical product imagery facts. Its glossary defines `Product Asset Set`, `Asset Variant`, `Source Asset`, and `Catalog Item Image Fallback`, and the Catalog asset-storage runbook says Catalog imports provider imagery, generates normalized WebP variants, and publishes Chase Sets-owned asset URLs.
- Discovery owns the browse/search/detail presentation. Its README says it owns browse, search, Search Results, and Detail Pages while remaining downstream of Catalog truth.
- The design system owns the reusable product media presentation primitive. The repository guidance says the design system is canonical for UI components and patterns with no custom overrides.
- Deployables are not owners for this change. Marketplace web should continue composing Discovery-owned route UI and design-system components.

## Resolved Decisions

- Use the image alpha channel as the physical-card boundary. Do not add a border, surface background, forced rounded wrapper, square shadow, or padding that creates a visible rectangular silhouette around real product imagery.
- Keep `object-fit: contain` for collectible images. Do not use cover-cropping because it can remove card edges, collector numbers, copyright text, or other condition-relevant details.
- Normalize empty edge padding in Catalog during Product Asset Set generation, not in route UI. Search and item detail should receive already-tight variants whenever Catalog owns the asset.
- Preserve the original provider image as the `Source Asset` for provenance and future regeneration. Generate display variants from the normalized display source.
- Make the normalization change cache-safe. Existing object keys are derived from source hash, role, width, and density; changing display bytes under the same URL would conflict with immutable cache headers. Implementation should include a normalization version or equivalent processing fingerprint in generated variant keys before producing trimmed variants for existing source images.
- Keep current `image_urls` compatibility behavior, but prefer `product_asset_sets` in Discovery for the canonical normalized images. Legacy direct `image_urls` may remain less polished until the Catalog item has a Product Asset Set.
- Introduce one design-system product media primitive, or equivalent shared internal helper, used by both `ListingCard` and `ImageGallery` for actual product images. Empty states and loading-only fallback presentation may keep design-system surfaces; real product images should be chrome-less.
- Search result cards may reserve a stable media area for layout, but the visible image itself should not be padded by default. Badges such as `Supply wanted` should remain overlay UI and must not become part of the image treatment.
- Do not introduce product-line corner metadata for this issue. Pokemon, Yu-Gi-Oh, and other card shapes should be represented by the asset itself. If a future provider supplies incorrect alpha, fix the provider/import normalization policy rather than teaching Discovery to guess physical corners.
- No new domain events are expected unless Catalog needs to publish updated Product Asset Sets for existing Catalog Items. If it does, the published fact remains `catalog.catalog-item.product-asset-sets-set`.

## Repo Evidence

- `bounded-contexts/catalog/GLOSSARY.md` defines `Product Asset Set` as the Catalog-owned normalized set of WebP image variants and `Asset Variant` as a generated WebP file.
- `docs/runbooks/catalog-asset-storage.md` says TCGdex imports download high quality `high.webp`, generate normalized WebP variants, and store immutable browser delivery variants for `thumbnail`, `search-card`, and `catalog-detail`.
- `bounded-contexts/catalog/features/source-observations/api/product-asset-normalization.ts` currently stores the original source and resizes variants with `fit: "inside"` but does not trim transparent/empty edge padding.
- `bounded-contexts/catalog/support/runtime-support/product-assets.ts` keys variant selection by role and density, and current generated object keys use role, width, density, and source hash without a processing-version discriminator.
- `bounded-contexts/discovery/features/search/ui/search-page.tsx` already prefers `selectDiscoveryProductAssetUrl(item.product_asset_sets, "search-card")` before falling back to direct `image_urls`.
- `bounded-contexts/discovery/features/item-detail/ui/item-detail-page.tsx` already prefers `selectDiscoveryProductAssetUrl(data.product_asset_sets, "catalog-detail")` before falling back to direct `image_urls`.
- `packages/design-system/src/components/ui/marketplace.tsx` renders `ListingCard` media inside a `bg-[var(--surface-2)]` frame and applies `p-3` to the image, which can create visible rectangular/padded presentation around transparent card corners.
- `packages/design-system/src/components/data-display/image-gallery.tsx` renders item-detail images inside a `modern-surface` frame with rounded corners and border, which can fight alpha-shaped Pokemon imagery and make square-corner cards look like rounded UI cards.
- `packages/design-system/MARKETPLACE_SYSTEM.md` identifies ListingCard as the primary marketplace comparison primitive and says search result relevance includes media.

## Open Questions

- None.

## Implementation Checklist

- Done: add Catalog asset-normalization coverage for transparent or near-empty edge padding, including a fixture that proves top/bottom padding is removed without cropping real card pixels.
- Done: add a cache-safe normalization discriminator to generated display variant keys by including `trim-alpha-v1` and the normalized display hash in each display variant key.
- Done: preserve original `Source Asset` bytes and source hash for provenance.
- Done: generate `thumbnail`, `search-card`, and `catalog-detail` variants from the normalized display image while preserving alpha.
- Done: update Catalog docs/runbook language to state that display variants preserve alpha and trim empty edge padding.
- Done: add a design-system product media primitive/shared helper that renders real product images chrome-less, alpha-preserving, `object-fit: contain`, and layout-stable.
- Done: refactor `ListingCard` to use the shared media treatment and remove default image padding/surface chrome from actual product images.
- Done: refactor `ImageGallery` to use the shared media treatment for actual product images while keeping empty/fallback frames intentional.
- Done: add design-system tests for alpha-preserving/chrome-less media rendering in ListingCard and ImageGallery.
- Done: add Discovery search and item-detail tests showing Product Asset Set URLs continue to drive the selected media.
- Done: run targeted Catalog, Discovery, and design-system tests.
- Done: start the marketplace app and visually verify dark and light mode for search-card and item-detail seeded card imagery. Representative transparent-padding and transparent-corner behavior is covered by the Catalog fixture test because the seeded catalog currently uses fallback card-back assets rather than old padded front scans, newer transparent-corner front scans, or square-corner card fronts.
- Done: submit draft PR `#229` from `codex/card-image-alpha-treatment`.

## Verification Evidence

- `pnpm --filter @chase-sets/catalog run test -- product-asset-normalization.test.ts tcgdex-client.test.ts`: passed, 2 files passed, 9 tests passed. The normalization fixture preserves the original source dimensions, trims transparent top/bottom display padding, keeps rounded-corner alpha in generated WebP variants, and emits cache-safe display keys with `trim-alpha-v1` plus display hash.
- `pnpm run test:design-system`: passed before rebase with 118 tests, then passed after rebase with 119 tests.
- `pnpm --filter @chase-sets/discovery run test -- search-page.test.tsx item-detail-commerce-panel.test.tsx`: passed before rebase with 54 tests, then passed after rebase with 55 tests.
- `pnpm run verify:typecheck`: passed.
- `pnpm run dev:bootstrap`: passed.
- `pnpm run sandbox:doctor`: passed with sandbox `8c4add4b`.
- `pnpm run dev:marketplace-full`: started Marketplace at `http://localhost:8953`, Platform API at `http://localhost:8962`, and Platform Worker at `http://localhost:8963`.
- Browser check against `http://localhost:8953/search`: search card image parent uses `bg-transparent`; image uses shared `ProductMediaImage` classes with `object-contain` and no `p-3`.
- Browser check against a seeded item detail page: gallery image parent uses `relative overflow-visible`; image uses shared `ProductMediaImage` classes with `object-contain` and no bordered/rounded `modern-surface` frame.
- Playwright visual check generated light/dark screenshots under `.codex/visuals/card-image-alpha-treatment` and confirmed search-card and item-detail media containers stay chrome-less in both color schemes.
- `pnpm run verify:build`: passed after rerun. The first attempt failed in `@chase-sets/app-admin-web` with Windows process exit `3221226505`, but `pnpm --filter @chase-sets/app-admin-web run build` passed immediately afterward and the full `verify:build` rerun passed.
- `pnpm run verify:build`: passed again after rebasing onto current `origin/main`.
- `pnpm run check:structure`: passed.
- `git diff --check`: passed.
- GitHub draft PR: `https://github.com/todd-skelton/chase-sets/pull/229`.

## Documentation To Promote

- Done: update `docs/runbooks/catalog-asset-storage.md` with the display-normalization and cache-key policy.
- Done: update `bounded-contexts/catalog/docs/catalog-item-imagery.md` with the alpha-preserving Product Asset Set presentation contract.
- Done: update `packages/design-system/MARKETPLACE_SYSTEM.md` with the product media rule: real product images are alpha-preserving and chrome-less; empty/loading states may use surfaces.

## Goal Completion Criteria

The later implementation goal must:

- Reference this worktree path, branch, and plan path.
- Implement Catalog asset normalization with cache-safe variant URLs.
- Implement one design-system product media treatment used by Discovery search and item detail.
- Promote the durable Catalog and design-system docs above.
- Verify targeted automated tests for Catalog asset normalization, Discovery media selection, and design-system media rendering.
- Perform desktop and mobile visual checks in light and dark mode for transparent-corner, padded, and square-corner card imagery.
- Submit a PR from `codex/card-image-alpha-treatment`.
- Reach passing CI.
- Merge the PR.
- Verify the staging deploy after merge.
- Verify the production deploy after promotion or rollout.
- Retain this `.codex/plans/20260520-card-image-alpha-treatment.md` file with the implementation.
