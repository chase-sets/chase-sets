/**
 * Catalog item slug derivation for Pricing's public market pages.
 *
 * Pricing does not depend on Discovery or Catalog in-process (no bounded
 * context in this codebase does -- catalog data reaches other contexts only
 * through projections, see docs/architecture/identifier-conventions.md).
 * Slug generation is likewise not a shared/contracts-level service: every
 * context that stores a slug computes its own copy from its own locally
 * projected title using the same small algorithm, kept in sync by hand
 * (the exact pattern documented for `/sets/:setSlug` and already used twice
 * in this repo -- discovery/support/runtime-support/slugs.ts and
 * contracts/catalog-seed/representative-commerce-state.ts).
 *
 * This copy is intentionally byte-for-byte identical to discovery's
 * `createMarketplaceSlug`/`createSlugBase` so that a catalog item's public
 * market-page slug (minted here, from `title`/`subtitle`/`catalogItemId`)
 * matches its marketplace item-detail slug (minted by discovery from the
 * same three inputs) -- letting "active listings for this item" CTAs link
 * straight to `/items/{slug}` on the marketplace without any cross-context
 * slug-resolution call.
 */

// Combining diacritical marks (U+0300-U+036F), stripped after NFKD
// normalization to fold accented characters down to their base letters.
// Built from character codes rather than a literal source range to avoid
// embedding raw combining-mark bytes in this file.
const COMBINING_DIACRITIC_PATTERN = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, "g");
const ID_SUFFIX_LABEL_LENGTH = 24;

export function createSlugBase(value: string): string {
  return value
    .normalize("NFKD")
    .replace(COMBINING_DIACRITIC_PATTERN, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function hashId(id: string): string {
  let hash = 0x811c9dc5;

  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36);
}

function compactIdSuffix(id: string): string {
  const suffix = createSlugBase(id).slice(-ID_SUFFIX_LABEL_LENGTH).replace(/^-+/, "");

  return `${suffix || "item"}-${hashId(id)}`;
}

export function createPricingCatalogItemSlug(parts: readonly (string | null | undefined)[], id: string): string {
  const base = createSlugBase(parts.filter(Boolean).join(" ")) || "item";

  return `${base}-${compactIdSuffix(id)}`;
}
