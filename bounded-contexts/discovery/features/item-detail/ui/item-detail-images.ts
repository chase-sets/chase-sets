import { t } from "@chase-sets/localization";
import type { DiscoveryItemDetail } from "../../../support/client-support/contracts";
import { buildDiscoveryProductAssetImage } from "../../../support/client-support/product-assets";

export function buildItemDetailImages(data: DiscoveryItemDetail) {
  const detailImage = buildDiscoveryProductAssetImage(
    data.product_asset_sets,
    "catalog-detail",
    "(min-width: 768px) 308px, min(100vw, 276px)",
  );
  const detailSrc = detailImage?.src;

  if (detailSrc) {
    const thumbnailImage = buildDiscoveryProductAssetImage(data.product_asset_sets, "thumbnail", "64px");

    return [
      {
        ...detailImage,
        src: detailSrc,
        thumbnailSrc: thumbnailImage?.src ?? detailSrc,
        thumbnailSrcSet: thumbnailImage?.srcSet,
        thumbnailSizes: thumbnailImage?.sizes,
        alt: t("discovery.features.itemDetail.ui.itemDetailPage.image.alt", {
          title: data.title,
          index: 1,
        }),
      },
    ];
  }

  return data.image_urls.map((url, index) => ({
    src: url,
    alt: t("discovery.features.itemDetail.ui.itemDetailPage.image.alt", {
      title: data.title,
      index: index + 1,
    }),
  }));
}
