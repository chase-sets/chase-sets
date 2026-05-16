import type { JsonObject } from "@chase-sets/primitives/json";

export type ProductAssetRole =
  | "source"
  | "thumbnail"
  | "search-card"
  | "catalog-detail";

export type ProductAssetVariant = JsonObject & Readonly<{
  role: ProductAssetRole;
  width: number;
  height: number;
  density: 1 | 2 | null;
  mediaType: "image/webp";
  storageKey: string;
  publicUrl: string;
  byteSize: number;
  generatedAt: string;
}>;

export type ProductAssetSet = JsonObject & Readonly<{
  kind: "product-image";
  sourceHash: string;
  source: ProductAssetVariant;
  variants: readonly ProductAssetVariant[];
}>;

export type ProductAssetVariantSpec = Readonly<{
  role: Exclude<ProductAssetRole, "source">;
  cssWidth: number;
  density: 1 | 2;
  width: number;
  quality: number;
}>;

export const PRODUCT_ASSET_VARIANT_SPECS: readonly ProductAssetVariantSpec[] = [
  {
    role: "thumbnail",
    cssWidth: 96,
    density: 1,
    width: 96,
    quality: 78,
  },
  {
    role: "thumbnail",
    cssWidth: 96,
    density: 2,
    width: 192,
    quality: 78,
  },
  {
    role: "search-card",
    cssWidth: 160,
    density: 1,
    width: 160,
    quality: 80,
  },
  {
    role: "search-card",
    cssWidth: 160,
    density: 2,
    width: 320,
    quality: 80,
  },
  {
    role: "catalog-detail",
    cssWidth: 480,
    density: 1,
    width: 480,
    quality: 84,
  },
  {
    role: "catalog-detail",
    cssWidth: 480,
    density: 2,
    width: 960,
    quality: 84,
  },
] as const;

export function selectProductAssetUrl(
  assetSet: ProductAssetSet | null | undefined,
  role: ProductAssetRole,
  density: 1 | 2 = 1,
): string | null {
  if (!assetSet) {
    return null;
  }

  if (role === "source") {
    return assetSet.source.publicUrl;
  }

  const exact = assetSet.variants.find(
    (variant) => variant.role === role && variant.density === density,
  );
  if (exact) {
    return exact.publicUrl;
  }

  return assetSet.variants.find((variant) => variant.role === role)?.publicUrl ?? null;
}

export function productAssetSetCompatibilityImageUrls(
  assetSet: ProductAssetSet | null | undefined,
): string[] {
  const detailUrl = selectProductAssetUrl(assetSet, "catalog-detail", 1);
  return detailUrl ? [detailUrl] : [];
}
