import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  PRODUCT_ASSET_VARIANT_SPECS,
  type ProductAssetSet,
  type ProductAssetVariant,
} from "../../../support/runtime-support/product-assets";
import type { CatalogAssetStorage } from "./asset-storage";

const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const DISPLAY_NORMALIZATION_VERSION = "trim-alpha-v1";
const ONE_PIECE_IMAGE_EVIDENCE_STALE_AFTER_DAYS = 365;

export const CATALOG_PRODUCT_IMAGE_RETENTION_POLICY = {
  policyKey: "catalog-product-image-retention-v1",
  retentionKind: "retain-while-referenced",
  previewRetentionDays: 90,
  takedownPath: "catalog-asset-takedown",
  removalSlaDays: 30,
} as const;

export type OnePieceImageEvidenceProviderKey = "scrydex" | "tcgplayer" | "bandai-official" | "comparison-only";

export type OnePieceImageEvidenceResult = Readonly<{
  status: "current" | "stale" | "missing" | "unapproved";
  imageUrls: readonly string[];
  diagnostics: readonly string[];
  retentionPolicy: typeof CATALOG_PRODUCT_IMAGE_RETENTION_POLICY;
}>;

export type CatalogImageProcessor = Readonly<{
  metadata(body: Uint8Array): Promise<{ width: number; height: number }>;
  normalizeDisplaySource(body: Uint8Array): Promise<Uint8Array>;
  resizeToWebp(input: {
    body: Uint8Array;
    width: number;
    quality: number;
  }): Promise<{ body: Uint8Array; width: number; height: number }>;
}>;

export type NormalizeProductAssetInput = Readonly<{
  sourceBody: Uint8Array;
  sourceContentType: string;
  sourceProviderKey?: string;
  sourceUrl?: string | null;
  storageBaseKey: string;
  generatedAt: string;
  assetStorage: CatalogAssetStorage;
  imageProcessor?: CatalogImageProcessor;
}>;

export async function normalizeProductAssetSet(input: NormalizeProductAssetInput): Promise<ProductAssetSet> {
  const imageProcessor = input.imageProcessor ?? sharpImageProcessor;
  const sourceHash = hashBytes(input.sourceBody);
  const displayBody = await imageProcessor.normalizeDisplaySource(input.sourceBody);
  const displayHash = hashBytes(displayBody);
  const sourceMetadata = await imageProcessor.metadata(input.sourceBody);
  const source = await storeVariant({
    assetStorage: input.assetStorage,
    storageKey: `${input.storageBaseKey}/source-${sourceHash.slice(0, 12)}.webp`,
    body: input.sourceBody,
    width: sourceMetadata.width,
    height: sourceMetadata.height,
    role: "source",
    density: null,
    generatedAt: input.generatedAt,
  });
  const variants: ProductAssetVariant[] = [];

  for (const spec of PRODUCT_ASSET_VARIANT_SPECS) {
    const resized = await imageProcessor.resizeToWebp({
      body: displayBody,
      width: spec.width,
      quality: spec.quality,
    });
    variants.push(
      await storeVariant({
        assetStorage: input.assetStorage,
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
    kind: "product-image",
    sourceHash,
    sourcePolicy: {
      sourceProviderKey: normalizeProviderKey(input.sourceProviderKey ?? "unknown"),
      sourceUrlHost: sourceUrlHost(input.sourceUrl ?? null),
      sourceUrlHash: input.sourceUrl ? hashString(input.sourceUrl) : null,
      sourceContentType: input.sourceContentType,
      approval: "catalog-owned-rehost-approved",
      rehostingBehavior: "store-source-and-webp-display-variants",
      retention: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
    },
    source,
    variants,
  };
}

export function extractApprovedOnePieceImageEvidence(input: {
  providerKey: OnePieceImageEvidenceProviderKey | string;
  imageUrls: readonly string[] | null | undefined;
  observedAt: string;
  sourceUpdatedAt?: string | null;
}): OnePieceImageEvidenceResult {
  const providerKey = normalizeProviderKey(input.providerKey);
  const approvedProvider = providerKey === "scrydex" || providerKey === "tcgplayer";
  if (!approvedProvider) {
    return {
      status: "unapproved",
      imageUrls: [],
      diagnostics: [`Provider '${providerKey}' is not approved for retained One Piece image evidence.`],
      retentionPolicy: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
    };
  }

  const imageUrls = [...new Set((input.imageUrls ?? []).map((url) => url.trim()).filter(isHttpsUrl))];
  if (imageUrls.length === 0) {
    return {
      status: "missing",
      imageUrls: [],
      diagnostics: [`${providerKey} did not provide approved One Piece image URI evidence.`],
      retentionPolicy: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
    };
  }

  if (isStaleImageEvidence(input.sourceUpdatedAt ?? null, input.observedAt)) {
    return {
      status: "stale",
      imageUrls,
      diagnostics: [
        `${providerKey} One Piece image URI evidence is older than ${ONE_PIECE_IMAGE_EVIDENCE_STALE_AFTER_DAYS} days and must be reviewed before rehosting.`,
      ],
      retentionPolicy: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
    };
  }

  return {
    status: "current",
    imageUrls,
    diagnostics: [],
    retentionPolicy: CATALOG_PRODUCT_IMAGE_RETENTION_POLICY,
  };
}

async function storeVariant(input: {
  assetStorage: CatalogAssetStorage;
  storageKey: string;
  body: Uint8Array;
  width: number;
  height: number;
  role: ProductAssetVariant["role"];
  density: ProductAssetVariant["density"];
  generatedAt: string;
}): Promise<ProductAssetVariant> {
  const stored = await input.assetStorage.putObject({
    key: input.storageKey,
    body: input.body,
    contentType: "image/webp",
    cacheControl: ASSET_CACHE_CONTROL,
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

const sharpImageProcessor: CatalogImageProcessor = {
  async metadata(body) {
    const metadata = await sharp(body).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("Product asset source image must have readable dimensions.");
    }

    return {
      width: metadata.width,
      height: metadata.height,
    };
  },
  async normalizeDisplaySource(body) {
    const { data } = await sharp(body)
      .ensureAlpha()
      .trim({
        threshold: 8,
      })
      .webp({ quality: 100, lossless: true })
      .toBuffer({ resolveWithObject: true });

    return new Uint8Array(data);
  },
  async resizeToWebp({ body, width, quality }) {
    const { data, info } = await sharp(body)
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

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeProviderKey(value: string): string {
  return value.trim().toLowerCase();
}

function sourceUrlHost(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isStaleImageEvidence(sourceUpdatedAt: string | null, observedAt: string): boolean {
  if (!sourceUpdatedAt) {
    return false;
  }
  const sourceTime = Date.parse(sourceUpdatedAt);
  const observedTime = Date.parse(observedAt);
  if (!Number.isFinite(sourceTime) || !Number.isFinite(observedTime)) {
    return false;
  }
  const ageMs = observedTime - sourceTime;
  return ageMs > ONE_PIECE_IMAGE_EVIDENCE_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}
