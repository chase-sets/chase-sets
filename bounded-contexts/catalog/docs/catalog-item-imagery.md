# Catalog Item Imagery

Catalog owns the canonical image facts for a Catalog Item.

`image_urls` remain the ordered front-facing item images. `image_fallback` is separate so one shared fallback asset, such as a Pokemon card back, can be reused across many Catalog Items without becoming the leading front image.

## Image Fallback Usage

- `permanent`: the fallback is real item imagery. Discovery may use it when no front image exists or when a front image fails, and item detail may include it as a selectable gallery image.
- `loading-only`: the fallback is only loading presentation. Discovery may show it while a front image loads, but it must not be appended to selectable galleries or treated as the permanent item image.

## Optimized Variants

Fallback images carry the same variant map shape expected by UI image consumers:

```json
{
  "card": { "oneX": "...", "twoX": "..." },
  "detail": { "oneX": "...", "twoX": "..." },
  "thumbnail": { "oneX": "...", "twoX": "..." }
}
```

Product-line differences, such as English Pokemon cards, Japanese Pokemon cards, and sealed products, should be expressed by assigning the appropriate Catalog-owned fallback asset to each Catalog Item.

## Product Asset Presentation

Product Asset Set display variants preserve the visible collectible shape. Catalog keeps the imported source asset unchanged, then generates browser display variants from an alpha-preserving normalized source that trims empty outer padding before resizing.

Consumers should treat Product Asset Set URLs as the preferred public item imagery. Discovery and other UI consumers should render those images with `object-fit: contain` and without decorative image borders, square backgrounds, or forced corner rounding around real product imagery. Empty states and loading-only fallbacks may use design-system surfaces because they are UI states rather than the physical collectible.
