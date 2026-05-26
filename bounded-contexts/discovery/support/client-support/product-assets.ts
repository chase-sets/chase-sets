import type { ResponsiveImageSource } from "@chase-sets/design-system";
import type { DiscoveryProductAssetRole, DiscoveryProductAssetSet, DiscoveryProductAssetVariant } from "./contracts";

export function selectDiscoveryProductAssetVariant(
  assetSet: DiscoveryProductAssetSet | null | undefined,
  role: DiscoveryProductAssetRole,
  density: 1 | 2 = 1,
): DiscoveryProductAssetVariant | null {
  const variants = assetSet?.variants.filter((variant) => variant.role === role) ?? [];

  return (
    variants.find((variant) => variant.density === density) ??
    variants.find((variant) => variant.density === 1) ??
    variants[0] ??
    null
  );
}

export function selectDiscoveryProductAssetUrl(
  assetSets: readonly DiscoveryProductAssetSet[] | null | undefined,
  role: DiscoveryProductAssetRole,
  density: 1 | 2 = 1,
): string | null {
  for (const assetSet of assetSets ?? []) {
    const variant = selectDiscoveryProductAssetVariant(assetSet, role, density);

    if (variant) {
      return variant.publicUrl;
    }
  }

  return null;
}

export function buildDiscoveryProductAssetSrcSet(
  assetSets: readonly DiscoveryProductAssetSet[] | null | undefined,
  role: DiscoveryProductAssetRole,
): string | undefined {
  const assetSet = assetSets?.[0];
  const variants =
    assetSet?.variants.filter((variant) => variant.role === role).sort((left, right) => left.width - right.width) ?? [];

  if (variants.length === 0) {
    return undefined;
  }

  return variants.map((variant) => `${variant.publicUrl} ${variant.width}w`).join(", ");
}

export function buildDiscoveryProductAssetImage(
  assetSets: readonly DiscoveryProductAssetSet[] | null | undefined,
  role: Exclude<DiscoveryProductAssetRole, "source">,
  sizes: string,
): ResponsiveImageSource | null {
  for (const assetSet of assetSets ?? []) {
    const variants = assetSet.variants
      .filter((variant) => variant.role === role)
      .sort((left, right) => left.width - right.width);
    const oneX = variants.find((variant) => variant.density === 1) ?? variants[0] ?? null;

    if (oneX) {
      return {
        src: oneX.publicUrl,
        srcSet: variants.map((variant) => `${variant.publicUrl} ${variant.width}w`).join(", "),
        sizes,
        width: oneX.width,
        height: oneX.height,
      };
    }
  }

  return null;
}
