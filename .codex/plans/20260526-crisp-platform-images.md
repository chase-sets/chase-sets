# Crisp Platform Images

## Intent

Catalog search images are blurry because the rendered image box can be larger than the browser-selected source file. The plan addresses that immediate Discovery search issue and closes the same class of problem across reusable product media surfaces.

The target outcome is crisp product and listing imagery across the platform without moving image ownership into deployables or making every route hand-author `srcset` and `sizes`.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-crisp-platform-images`
- Branch: `codex/crisp-platform-images`
- Base: freshly fetched `origin/main` at `31cf17b2`
- Sandbox id: `46c6cdfe`
- Dependency setup status: `pnpm run deps:install` completed and `pnpm run sandbox:doctor` passed
- pnpm store path: default `.codex/worktrees/.chase-sets-pnpm-store` when implementation begins
- Setup blockers: none for planning

## Owning Contexts

- Catalog owns `Product Asset Set`, `Asset Variant`, role names, generated WebP bytes, and the integration events that publish product imagery.
- Discovery owns browse/search/detail presentation and its projection of Catalog `product_asset_sets`.
- Marketplace owns seller-supplied `Listing Photo` asset sets and account listing UI.
- Checkout owns durable cart presentation snapshots once Discovery hands product intent to the cart.
- Design System owns reusable product media rendering behavior and should be the canonical UI contract for crisp image slots.

## Repo Evidence

- `docs/runbooks/catalog-asset-storage.md` defines browser delivery variants by role: `thumbnail` 96w/192w, `search-card` 160w/320w, and `catalog-detail` 480w/960w.
- `bounded-contexts/catalog/support/runtime-support/product-assets.ts` stores `cssWidth`, `width`, `height`, `density`, and public URL facts for Product Asset Set variants.
- `bounded-contexts/discovery/features/search/ui/search-page.tsx` uses `search-card` variants but hard-codes `imageSizes` to `160px` while `ListingCard` can render the image much larger.
- `packages/design-system/src/components/ui/marketplace.tsx` accepts `imageSrcSet` and `imageSizes`, but `ListingCard` does not encode a canonical rendered media slot or cap real product media to the selected role width.
- `packages/design-system/src/components/data-display/product-media.tsx` renders every product image as `h-full w-full object-contain`, which makes the component stretch to its parent instead of the variant role's intended CSS width.
- `packages/design-system/src/components/data-display/image-gallery.tsx` supports `srcSet` and `sizes`, but Marketplace listing detail currently passes only 1x URLs.
- `bounded-contexts/marketplace/features/listings/ui/listing-detail-page.tsx` selects the density-1 listing photo URL for gallery detail and thumbnail roles and drops the 2x variants.
- `bounded-contexts/checkout/features/cart/ui/cart-page.tsx` passes a primary cart image URL without primary `srcSet`; the route handoff stores only `item_image_url` plus fallback loading `srcset`.

## Resolved Decisions

- Treat this as a presentation-contract bug, not an object-storage bug. Catalog already generates the variants needed for a 160 CSS px search slot and a 480 CSS px detail slot.
- Do not make deployables own image sizing. Behavior belongs in bounded contexts plus design-system primitives.
- Keep Catalog's existing `search-card` role at 160 CSS px for the first fix. The cleanest immediate solution is to cap search/listing-card product media to the role contract and let 320w serve DPR 2.
- Add a reusable product image descriptor shape in the design-system data-display surface: `src`, `srcSet`, `sizes`, `width`, `height`, and optional slot metadata. Context-specific helpers should map bounded-context asset sets into that generic UI descriptor.
- Keep Catalog product imagery and Marketplace listing photos separate at the domain layer. They can share UI descriptor conventions without sharing domain types.
- Checkout should store the responsive image facts it receives during cart-line creation because cart lines are durable saved buyer intent. It should not query Discovery at render time to rediscover image variants.
- Legacy `image_urls` remain compatibility fallbacks. They should render without `srcset` only when no Product Asset Set is available.

## Recommended Implementation Plan

1. Design System media contract
   - Add a small exported `ResponsiveImageSource` or similarly named type under `packages/design-system/src/components/data-display`.
   - Extend `ProductMediaImage`, `ListingCard`, `MarketplaceCartLineItem`, and `ImageGallery` usage patterns so callers can pass one descriptor rather than loose `src`, `srcSet`, `sizes`, `width`, and `height` strings.
   - Add design-system tests that render the descriptor through `ListingCard`, cart line items, and `ImageGallery`.

2. ListingCard search media slot
   - Add a canonical compact product media slot for `ListingCard` that caps real product media to 160 CSS px in search/listing cards while preserving the current chrome-less alpha treatment.
   - Remove hard-coded route-level `imageSizes` from Discovery search where the design system can provide the canonical value.
   - Keep fallback/placeholder surfaces unchanged except for matching responsive source metadata.

3. Discovery Product Asset Set helper
   - Replace `selectDiscoveryProductAssetUrl` plus `buildDiscoveryProductAssetSrcSet` call pairs with a helper that returns a complete responsive image descriptor for a role.
   - For `search-card`, emit `sizes: "160px"` and density/width descriptors from the available variants.
   - For `catalog-detail`, emit the current detail sizes and include width/height from the selected 1x variant.
   - Add focused tests that assert `src`, `srcSet`, `sizes`, `width`, and `height` for search cards and item detail images.

4. Marketplace Listing Photo gallery descriptors
   - Add a Marketplace listing-photo helper that builds `ImageGallery` descriptors from `listing_photos[].assetSet.variants`.
   - Pass `catalog-detail` 480w/960w as gallery images and `thumbnail` 96w/192w as thumbnail descriptors.
   - Add tests that prove listing detail no longer drops density-2 listing photo variants.

5. Checkout cart responsive image handoff
   - Extend Checkout cart-line command/input/read-model/UI contracts with nullable primary `item_image_srcset`, and optionally `item_image_width`/`item_image_height` if the descriptor is adopted end-to-end.
   - Update Discovery item-detail and search bulk-add handoffs to include the thumbnail descriptor, not just a URL.
   - Update `MarketplaceCartLineItem` calls to pass the primary `srcSet` and fixed cart-line `sizes` value.
   - Preserve compatibility for existing cart rows where the new fields are null.

6. Verification
   - Run focused Vitest suites for design-system, Discovery search/detail, Marketplace listing detail, and Checkout cart.
   - Add Playwright/browser checks for `/search`, item detail, listing detail, and cart at DPR 1 and DPR 2. Assert that rendered image width does not exceed the matching asset role's CSS slot, and that `currentSrc` selects a candidate whose intrinsic width is at least `ceil(renderedWidth * devicePixelRatio)` when a variant exists.
   - Use a visual screenshot pass for the reported search-card case to confirm the rendered image no longer exceeds its selected source.

## Implementation Progress

- Completed: added a design-system `ResponsiveImageSource` descriptor and support in `ProductMediaImage`, `ListingCard`, `MarketplaceCartLineItem`, and `ImageGallery`.
- Completed: added a compact product media slot for `ListingCard` so Discovery search can render Catalog `search-card` imagery at the role's 160 CSS px contract.
- Completed: added a Discovery Product Asset Set descriptor helper and updated search/detail UI to use it.
- Completed: extended Checkout cart line snapshots with nullable primary `item_image_srcset` and updated Discovery add-to-cart handoffs to preserve thumbnail variants.
- Completed: updated Marketplace listing detail to pass listing-photo detail and thumbnail `srcset` values into `ImageGallery`.
- Completed: promoted image-role rendering-contract guidance into the Catalog asset runbook and marketplace design-system guide.
- Completed: formatted touched files with Prettier.
- Completed: focused verification passed for design-system, Discovery, Marketplace, and Checkout Vitest suites.
- Completed: `pnpm run verify:typecheck` passed.
- Completed: delivery verification passed for `pnpm run verify:static`, `pnpm run verify:typecheck`, `pnpm run verify:test`, `pnpm run verify:build`, and `pnpm run verify:db`.
- Blocked: browser smoke through the normal `dev:marketplace-full` path is blocked by local platform-worker SES env requirements. A direct web/API smoke path was attempted but did not reach a stable server in this shell session; no product code changes are blocked by this.

## Alternatives Rejected

- Generate larger `search-card` variants immediately. This would mask the current UI-slot mismatch and increase bandwidth across every search result. It should be reserved for a deliberate design change where search cards intentionally need images wider than 160 CSS px.
- Use the original `source` asset on search cards. This would be crisp but wasteful for dense search grids and bypass Catalog's delivery-role policy.
- Fix only Discovery search. That would leave the same failure mode in Marketplace listing galleries and Checkout cart lines.

## Stress Test

- Normal flow: Catalog publishes Product Asset Sets; Discovery projects them; search/detail render responsive descriptors; browser selects adequate variants.
- Partial flow: If Product Asset Sets are missing, UI falls back to legacy `image_urls` or permanent fallback imagery without breaking layout.
- Stale data/replay: Projection replay republishes the same immutable asset URLs; responsive descriptors are derived at render time from projected facts.
- Cross-context handoff: Checkout stores a presentation snapshot received from Discovery. Existing cart rows continue to render with nullable new fields.
- Failure/cancellation: Broken primary images retain existing fallback image behavior; new descriptor fields should not bypass `onError` fallback handling.
- Low-value card economics: Search grids should avoid loading oversized source assets; the 160 CSS px search role keeps bandwidth low for browse-heavy workflows.

## Documentation To Promote

- Update `docs/runbooks/catalog-asset-storage.md` to state that each role's `cssWidth` is a rendering contract, not just generation metadata.
- Update `packages/design-system/MARKETPLACE_SYSTEM.md` with the rule that real product media must use the shared responsive product image descriptor and role-appropriate slot, not route-local ad hoc `sizes`.

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
