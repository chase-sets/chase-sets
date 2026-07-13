import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  listingPhotoAssetRevision,
  type MarketplaceListingPhoto,
  type MarketplaceListingPhotoAssetRole,
  type MarketplaceListingPhotoAssetVariant,
} from "../domain/domain";
import {
  assertDecodedImageWithinBudget,
  DEFAULT_LISTING_EVIDENCE_MAX_SOURCE_PIXELS,
} from "../domain/evidence-governance";

const LISTING_PHOTO_CACHE_CONTROL = "public, max-age=31536000, immutable";
const DISPLAY_NORMALIZATION_VERSION = "trim-alpha-v1";

export const LISTING_PHOTO_VARIANT_SPECS: readonly Readonly<{
  role: Exclude<MarketplaceListingPhotoAssetRole, "source">;
  width: number;
  density: 1 | 2;
  quality: number;
}>[] = [
  { role: "thumbnail", width: 96, density: 1, quality: 82 },
  { role: "thumbnail", width: 192, density: 2, quality: 82 },
  { role: "search-card", width: 160, density: 1, quality: 84 },
  { role: "search-card", width: 320, density: 2, quality: 84 },
  { role: "catalog-detail", width: 480, density: 1, quality: 86 },
  { role: "catalog-detail", width: 960, density: 2, quality: 86 },
];

export type ListingPhotoStorage = Readonly<{
  putObject(
    input: Readonly<{
      key: string;
      body: Uint8Array;
      contentType: string;
      cacheControl?: string;
    }>,
  ): Promise<Readonly<{ key: string; publicUrl: string }>>;
  /**
   * Idempotent bulk delete for evidence garbage collection. Deleting an
   * already-absent key must be a no-op. Optional so standalone/test wiring
   * without object storage still constructs; GC reports candidates but skips
   * physical deletion when absent.
   */
  deleteObjects?: (keys: readonly string[]) => Promise<void>;
}>;

export type ListingPhotoImageProcessor = Readonly<{
  metadata(body: Uint8Array): Promise<{ width: number; height: number }>;
  normalizeDisplaySource(body: Uint8Array): Promise<Uint8Array>;
  resizeToWebp(
    input: Readonly<{
      body: Uint8Array;
      width: number;
      quality: number;
    }>,
  ): Promise<{ body: Uint8Array; width: number; height: number }>;
}>;

export type NormalizeListingPhotoInput = Readonly<{
  sourceBody: Uint8Array;
  storageBaseKey: string;
  photoId: string;
  originalFilename: string | null;
  altText: string | null;
  slotId?: string | null;
  viewKind?: string | null;
  capturedAt?: string | null;
  replacesPhotoId?: string | null;
  sortOrder: number;
  generatedAt: string;
  maxSourcePixels?: number;
  photoStorage: ListingPhotoStorage;
  imageProcessor?: ListingPhotoImageProcessor;
}>;

export async function normalizeListingPhoto(input: NormalizeListingPhotoInput): Promise<MarketplaceListingPhoto> {
  const imageProcessor = input.imageProcessor ?? sharpListingPhotoImageProcessor;
  const sourceHash = hashBytes(input.sourceBody);
  // Validate the decoded content is a real image with sane dimensions BEFORE
  // any expensive re-encode, so a malformed file or decompression bomb fails
  // safely rather than exhausting memory during normalization.
  const rawMetadata = await imageProcessor.metadata(input.sourceBody);
  assertDecodedImageWithinBudget(rawMetadata, {
    maxSourcePixels: input.maxSourcePixels ?? DEFAULT_LISTING_EVIDENCE_MAX_SOURCE_PIXELS,
  });
  const displayBody = await imageProcessor.normalizeDisplaySource(input.sourceBody);
  const displayHash = hashBytes(displayBody);
  const sourceMetadata = await imageProcessor.metadata(displayBody);
  assertDecodedImageWithinBudget(sourceMetadata, {
    maxSourcePixels: input.maxSourcePixels ?? DEFAULT_LISTING_EVIDENCE_MAX_SOURCE_PIXELS,
  });
  const source = await storeVariant({
    photoStorage: input.photoStorage,
    storageKey: `${input.storageBaseKey}/source-${sourceHash.slice(0, 12)}-${DISPLAY_NORMALIZATION_VERSION}-${displayHash.slice(0, 12)}.webp`,
    body: displayBody,
    width: sourceMetadata.width,
    height: sourceMetadata.height,
    role: "source",
    density: null,
    generatedAt: input.generatedAt,
  });
  const variants: MarketplaceListingPhotoAssetVariant[] = [];

  for (const spec of LISTING_PHOTO_VARIANT_SPECS) {
    const resized = await imageProcessor.resizeToWebp({
      body: displayBody,
      width: spec.width,
      quality: spec.quality,
    });
    variants.push(
      await storeVariant({
        photoStorage: input.photoStorage,
        storageKey: `${input.storageBaseKey}/${spec.role}-${spec.width}w-${spec.density}x-${sourceHash.slice(0, 12)}-${DISPLAY_NORMALIZATION_VERSION}-${displayHash.slice(0, 12)}.webp`,
        body: resized.body,
        width: resized.width,
        height: resized.height,
        role: spec.role,
        density: spec.density,
        generatedAt: input.generatedAt,
      }),
    );
  }

  return {
    photoId: input.photoId,
    originalFilename: input.originalFilename,
    altText: input.altText,
    slotId: input.slotId ?? null,
    viewKind: input.viewKind ?? null,
    status: "active",
    sortOrder: input.sortOrder,
    capturedAt: input.capturedAt ?? null,
    uploadedAt: input.generatedAt,
    assetRevision: listingPhotoAssetRevision(sourceHash),
    replacesPhotoId: input.replacesPhotoId ?? null,
    assetSet: {
      kind: "listing-photo",
      sourceHash,
      source,
      variants,
    },
  };
}

async function storeVariant(input: {
  photoStorage: ListingPhotoStorage;
  storageKey: string;
  body: Uint8Array;
  width: number;
  height: number;
  role: MarketplaceListingPhotoAssetVariant["role"];
  density: MarketplaceListingPhotoAssetVariant["density"];
  generatedAt: string;
}): Promise<MarketplaceListingPhotoAssetVariant> {
  const stored = await input.photoStorage.putObject({
    key: input.storageKey,
    body: input.body,
    contentType: "image/webp",
    cacheControl: LISTING_PHOTO_CACHE_CONTROL,
  });

  return {
    role: input.role,
    width: input.width,
    height: input.height,
    density: input.density,
    mediaType: "image/webp",
    storageKey: stored.key,
    publicUrl: stored.publicUrl,
    byteSize: input.body.byteLength,
    generatedAt: input.generatedAt,
  };
}

// Decoder-level guard: cap the pixels sharp will decode so a decompression
// bomb is rejected by the decoder itself, in addition to the domain-level
// `assertDecodedImageWithinBudget` applied to the reported dimensions.
const SHARP_INPUT_PIXEL_LIMIT = DEFAULT_LISTING_EVIDENCE_MAX_SOURCE_PIXELS;

const sharpListingPhotoImageProcessor: ListingPhotoImageProcessor = {
  async metadata(body) {
    const metadata = await sharp(body, { limitInputPixels: SHARP_INPUT_PIXEL_LIMIT }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("Listing photo source image must have readable dimensions.");
    }

    return {
      width: metadata.width,
      height: metadata.height,
    };
  },
  async normalizeDisplaySource(body) {
    const { data } = await sharp(body, { limitInputPixels: SHARP_INPUT_PIXEL_LIMIT })
      .ensureAlpha()
      .trim({ threshold: 8 })
      .webp({ quality: 100, lossless: true })
      .toBuffer({ resolveWithObject: true });

    return new Uint8Array(data);
  },
  async resizeToWebp({ body, width, quality }) {
    const { data, info } = await sharp(body, { limitInputPixels: SHARP_INPUT_PIXEL_LIMIT })
      .resize({
        width,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });

    return {
      body: new Uint8Array(data),
      width: info.width,
      height: info.height,
    };
  },
};

function hashBytes(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
