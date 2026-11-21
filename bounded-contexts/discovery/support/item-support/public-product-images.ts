import type { createPublicProductUrlPolicy } from "@chase-sets/platform-runtime/public-product-urls";
import type { DiscoveryItemDetailRow } from "../../features/item-detail/read-model/queries";

export function publicProductImages(
  row: Pick<DiscoveryItemDetailRow, "image_urls" | "image_fallback" | "product_asset_sets">,
  resolve: ReturnType<typeof createPublicProductUrlPolicy>["resolve"],
): string[] {
  const images = [
    ...(Array.isArray(row.image_urls) ? row.image_urls : []),
    field(row.image_fallback, "url"),
    ...(Array.isArray(row.product_asset_sets)
      ? row.product_asset_sets.map((asset) => field(field(asset, "source"), "publicUrl"))
      : []),
  ];
  return [...new Set(images.map(resolve).filter((url): url is string => url !== undefined))];
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
}
