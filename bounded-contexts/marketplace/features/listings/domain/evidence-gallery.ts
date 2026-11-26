import type { ListingEvidenceSnapshot } from "./evidence-snapshot";
import { activeListingPhotos, type MarketplaceListingPhoto, type MarketplaceListingPhotoAssetVariant } from "./domain";
import { publicEntries, publicNumber, publicText } from "./public-values";

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

function copyPublicAsset(asset: Readonly<Record<string, unknown>>): MarketplaceListingPublicGalleryImageAsset | null {
  const role = publicText(asset.role);
  const publicUrl = publicText(asset.publicUrl);
  const width = publicNumber(asset.width);
  const height = publicNumber(asset.height);
  if (role === null || publicUrl === null || width === null || height === null) return null;
  return { role, publicUrl, width, height, density: asset.density === 1 || asset.density === 2 ? asset.density : null };
}

function copyPublicImage(image: Readonly<Record<string, unknown>>): MarketplaceListingPublicGalleryImage | null {
  const photoId = publicText(image.photoId);
  const sortOrder = publicNumber(image.sortOrder);
  if (photoId === null || sortOrder === null) return null;
  return {
    photoId,
    slotId: publicText(image.slotId),
    viewKind: publicText(image.viewKind),
    altText: publicText(image.altText),
    sortOrder,
    assets: publicEntries(image.assets, copyPublicAsset),
  };
}

/**
 * Copies a public gallery key by key and checks each value's type, so an image or asset passed in with
 * other fields, or with a value of another type, cannot carry it out. A malformed image or asset is dropped.
 */
export function copyPublicListingGallery(gallery: unknown): MarketplaceListingPublicGalleryImage[] {
  return publicEntries(gallery, copyPublicImage);
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

/**
 * Buyer-safe projection for an immutable commitment snapshot. The adapter
 * deliberately reuses `toPublicListingGallery`, so historical reads have the
 * same privacy boundary as current Listing reads.
 */
export function toPublicListingEvidenceSnapshotGallery(
  snapshot: ListingEvidenceSnapshot | null | undefined,
): MarketplaceListingPublicGalleryImage[] {
  if (!snapshot) {
    return [];
  }

  const evidence: MarketplaceListingPhoto[] = snapshot.evidence.map((item) => {
    const assets = item.assets.map(
      (asset) =>
        ({
          ...asset,
          role: asset.role as MarketplaceListingPhotoAssetVariant["role"],
          generatedAt: snapshot.createdAt,
        }) as MarketplaceListingPhotoAssetVariant,
    );
    const source = assets.find((asset) => asset.role === "source") ?? assets[0];

    return {
      photoId: item.photoId,
      originalFilename: null,
      altText: null,
      slotId: item.slotId,
      viewKind: item.viewKind,
      status: "active",
      sortOrder: item.sortOrder,
      capturedAt: item.capturedAt,
      uploadedAt: item.uploadedAt,
      assetRevision: item.assetRevision,
      replacesPhotoId: null,
      assetSet: {
        kind: "listing-photo",
        sourceHash: item.sourceHash,
        source: source ?? ({} as MarketplaceListingPhotoAssetVariant),
        variants: source ? assets.filter((asset) => asset !== source) : [],
      },
    };
  });

  return toPublicListingGallery(evidence);
}
