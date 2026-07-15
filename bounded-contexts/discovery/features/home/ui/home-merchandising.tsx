import { FeatureCard, Grid, LinkButton, ListingCard, PageSection, Stack, Text } from "@chase-sets/design-system";
import { formatDisplayIdentity, t } from "@chase-sets/localization";
import type { DiscoveryCategoryItem } from "../../categories/ui/contracts";
import type { DiscoverySearchItem } from "../../../support/client-support/contracts";
import { imageVariantSrcSet } from "../../../support/client-support/assets";
import { buildDiscoveryProductAssetImage } from "../../../support/client-support/product-assets";
import { formatMoney } from "../../../support/ui-support/formatting";

export type HomeMerchandisingData = Readonly<{
  featuredCategories: readonly DiscoveryCategoryItem[];
  newArrivals: readonly DiscoverySearchItem[];
}>;

export function HomeMerchandising({ featuredCategories, newArrivals }: HomeMerchandisingData) {
  if (featuredCategories.length === 0 && newArrivals.length === 0) {
    return null;
  }

  return (
    <Stack gap={6}>
      {featuredCategories.length > 0 ? (
        <PageSection
          title={t("discovery.features.home.ui.homeMerchandising.featured.categories")}
          description={t("discovery.features.home.ui.homeMerchandising.featured.categories.description")}
        >
          <Grid columns={{ base: 1, md: 2, xl: 4 }} gap={3}>
            {featuredCategories.map((category) => (
              <FeatureCard
                key={category.category_id}
                icon="grid"
                title={category.name}
                description={
                  <Stack gap={1}>
                    {category.description ? <Text size="sm">{category.description}</Text> : null}
                    <Text size="sm" tone="secondary">
                      {t("discovery.features.home.ui.homeMerchandising.item.count", {
                        count: category.item_count,
                      })}
                    </Text>
                  </Stack>
                }
                action={
                  <LinkButton href={`/categories/${category.slug}`} size="sm" tone="secondary">
                    {t("discovery.features.home.ui.homeMerchandising.browse.category", {
                      category: category.name,
                    })}
                  </LinkButton>
                }
              />
            ))}
          </Grid>
        </PageSection>
      ) : null}

      {newArrivals.length > 0 ? (
        <PageSection
          title={t("discovery.features.home.ui.homeMerchandising.new.arrivals")}
          description={t("discovery.features.home.ui.homeMerchandising.new.arrivals.description")}
        >
          <Stack gap={3}>
            <Grid columns={{ base: 1, lg: 2, "2xl": 3 }} gap={4}>
              {newArrivals.map((item) => {
                const href = `/items/${item.slug || item.catalog_item_id}`;
                const displayIdentity = formatDisplayIdentity(item.title, item.subtitle);
                const productAssetImage = buildDiscoveryProductAssetImage(
                  item.product_asset_sets,
                  "search-card",
                  "(min-width: 768px) 164px, 124px",
                );
                const imageSrc =
                  productAssetImage?.src ??
                  item.image_urls[0] ??
                  (item.image_fallback?.usage === "permanent" ? item.image_fallback.url : undefined);
                const lowestPrice = item.market_summary?.lowest_price_amount ?? null;

                return (
                  <ListingCard
                    key={item.catalog_item_id}
                    cardLayout="search-result"
                    href={href}
                    title={item.title}
                    subtitle={item.subtitle}
                    image={productAssetImage ?? undefined}
                    imageSrc={imageSrc}
                    imageSlot="compact-product"
                    imageAlt={displayIdentity}
                    imageFallbackSrc={item.image_fallback?.url}
                    imageFallbackAlt={displayIdentity}
                    imageFallbackSrcSet={imageVariantSrcSet(item.image_fallback, "card")}
                    imageFallbackSizes="(min-width: 768px) 164px, 124px"
                    imageFallbackMode={item.image_fallback?.usage ?? "permanent"}
                    detailLinkLabel={t("localization.listingCard.view.details.for", { identity: displayIdentity })}
                    saveLabel={t("localization.listingCard.save", { identity: displayIdentity })}
                    savedLabel={t("localization.listingCard.saved", { identity: displayIdentity })}
                    watchingLabel={t("localization.listingCard.watching", { identity: displayIdentity })}
                    price={
                      lowestPrice
                        ? t("discovery.features.home.ui.homeMerchandising.from.price", {
                            price: formatMoney(lowestPrice),
                          })
                        : undefined
                    }
                    primaryAction={
                      <LinkButton href={href} size="sm">
                        {t("discovery.features.home.ui.homeMerchandising.view.item")}
                      </LinkButton>
                    }
                  />
                );
              })}
            </Grid>
            <LinkButton href="/search?sort=newest" tone="secondary">
              {t("discovery.features.home.ui.homeMerchandising.browse.all.new.arrivals")}
            </LinkButton>
          </Stack>
        </PageSection>
      ) : null}
    </Stack>
  );
}
