import { Grid, LinkButton, ListingCard, PageSection } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { DiscoverySimilarItem } from "../../../support/client-support/contracts";
import { imageVariantSrcSet } from "../../../support/client-support/assets";
import { buildDiscoveryProductAssetImage } from "../../../support/client-support/product-assets";
import { trackItemDetailRailEvent } from "./item-detail-rail-analytics";

export function ItemDetailSimilarItems({ items }: { items: readonly DiscoverySimilarItem[] }) {
  if (items.length === 0) return null;

  return (
    <PageSection title={t("discovery.features.itemDetail.ui.similarItems.title")}>
      <Grid columns={{ base: 1, lg: 2 }} gap={4}>
        {items.map((item) => {
          const href = `/items/${item.slug || item.catalog_item_id}`;
          const productAssetImage = buildDiscoveryProductAssetImage(
            item.product_asset_sets,
            "search-card",
            "(min-width: 768px) 164px, 124px",
          );
          const imageSrc =
            productAssetImage?.src ??
            item.image_urls[0] ??
            (item.image_fallback?.usage === "permanent" ? item.image_fallback.url : undefined);

          return (
            <ListingCard
              key={item.catalog_item_id}
              cardLayout="search-result"
              title={item.title}
              subtitle={item.subtitle}
              image={productAssetImage ?? undefined}
              imageSrc={imageSrc}
              imageSlot="compact-product"
              imageAlt={item.title}
              imageFallbackSrc={item.image_fallback?.url}
              imageFallbackAlt={item.image_fallback?.alt ?? item.title}
              imageFallbackSrcSet={imageVariantSrcSet(item.image_fallback, "card")}
              imageFallbackSizes="(min-width: 768px) 164px, 124px"
              imageFallbackMode={item.image_fallback?.usage ?? "permanent"}
              primaryAction={
                <LinkButton
                  href={href}
                  size="sm"
                  onClick={() =>
                    trackItemDetailRailEvent("similar_item_selected", {
                      surface: "similar_items",
                      selection: "implicit",
                    })
                  }
                >
                  {t("discovery.features.itemDetail.ui.similarItems.viewItem")}
                </LinkButton>
              }
            />
          );
        })}
      </Grid>
    </PageSection>
  );
}
