import { activeListingPhotos, type MarketplaceListingPhoto } from "./domain";

/**
 * Public-safe Listing Evidence gallery projection.
 *
 * Buyer-facing reads must expose only buyer-safe metadata. Storage keys,
 * source hashes, byte sizes, original filenames, account/storage paths,
 * internal audit fields, and non-active lifecycle entries must never leak into
 * public representations. This mapper is the single boundary that strips a
 * private evidence set down to that buyer-safe shape; public read paths pass
 * evidence through it, while seller-owned surfaces keep the full entry.
 *
 * Consumed by seller preview and buyer order review surfaces. Exposed here as
 * the canonical contract.
 */
export type MarketplaceListingPublicGalleryImageAsset = Readonly<{
  role: string;
  publicUrl: string;
  width: number;
  height: number;
  density: 1 | 2 | null;
}>;

export type MarketplaceListingPublicGalleryImage = Readonly<{
  photoId: string;
  slotId: string | null;
  viewKind: string | null;
  altText: string | null;
  sortOrder: number;
  assets: readonly MarketplaceListingPublicGalleryImageAsset[];
}>;

function publicAsset(variant: {
  role: string;
  publicUrl: string;
  width: number;
  height: number;
  density: 1 | 2 | null;
}): MarketplaceListingPublicGalleryImageAsset {
  return {
    role: variant.role,
    publicUrl: variant.publicUrl,
    width: variant.width,
    height: variant.height,
    density: variant.density,
  };
}

export function toPublicListingGallery(
  evidence: readonly MarketplaceListingPhoto[],
): MarketplaceListingPublicGalleryImage[] {
  return activeListingPhotos(evidence)
    .slice()
    .sort((left, right) =>
      left.sortOrder === right.sortOrder ? left.photoId.localeCompare(right.photoId) : left.sortOrder - right.sortOrder,
    )
    .map((photo) => ({
      photoId: photo.photoId,
      slotId: photo.slotId,
      viewKind: photo.viewKind,
      altText: photo.altText,
      sortOrder: photo.sortOrder,
      // The public gallery intentionally excludes the `source` variant (the
      // full-resolution normalized original) — buyers get the display-sized
      // roles only.
      assets: photo.assetSet.variants.map(publicAsset),
    }));
}
