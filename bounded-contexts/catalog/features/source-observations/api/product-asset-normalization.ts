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
  storageBaseKey: string;
  generatedAt: string;
  assetStorage: CatalogAssetStorage;
  imageProcessor?: CatalogImageProcessor;
}>;

export async function normalizeProductAssetSet(
  input: NormalizeProductAssetInput,
): Promise<ProductAssetSet> {
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
    source,
    variants,
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
