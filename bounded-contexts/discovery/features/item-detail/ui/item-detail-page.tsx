import { t } from "@chase-sets/localization";
import {
  Banner,
  Breadcrumbs,
  Container,
  Heading,
  Icon,
  ImageGallery,
  MarketplaceMarketSummary,
  MarketplaceProductDetailLayout,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type {
  DiscoveryItemDetail,
  DiscoveryAccountOfferMatch,
  DiscoverySimilarItem,
} from "../../../support/client-support/contracts";
import { imageVariantSrcSet } from "../../../support/client-support/assets";
import type { MarketIntent } from "../domain/item-detail-market";
import { ReferenceDetailDialog } from "./item-detail-references";
import { ItemDetailMarketBook } from "./item-detail-market-book";
import { ItemDetailProductContents } from "./item-detail-product-contents";
import { ItemDetailSimilarItems } from "./item-detail-similar-items";
import { useItemDetailPageModel, type LoadedItemDetailPageProps } from "./use-item-detail-page-model";
import type { ItemDetailCommerceSections, ItemDetailMarketplaceSectionContext } from "./item-detail-page-types";

export type {
  ItemDetailCommerceSections,
  ItemDetailMarketplaceSectionContext,
  ItemDetailMobileCommerceSection,
} from "./item-detail-page-types";

export function ItemDetailPage({
  data,
  similarItems = [],
  notFound = false,
  error = null,
  accountOfferMatches = [],
  viewerAccountId = null,
  initialMarketIntent = "buy",
  initialSelectedListingId = null,
  initialSelectedOfferId = null,
  initialSelectedOptions = [],
  hasInitialSelectedOptionFilters = false,
  renderCommerce,
}: {
  data: DiscoveryItemDetail | null;
  similarItems?: readonly DiscoverySimilarItem[];
  notFound?: boolean;
  error?: string | null;
  accountOfferMatches?: readonly DiscoveryAccountOfferMatch[];
  viewerAccountId?: string | null;
  initialMarketIntent?: MarketIntent;
  initialSelectedListingId?: string | null;
  initialSelectedOfferId?: string | null;
  initialSelectedOptions?: readonly { dimensionId: string; optionId: string }[];
  hasInitialSelectedOptionFilters?: boolean;
  renderCommerce?: (context: ItemDetailMarketplaceSectionContext) => ItemDetailCommerceSections | null;
}) {
  if (error) {
    return (
      <Banner tone="danger" title={t("discovery.features.itemDetail.ui.itemDetailPage.error")} description={error} />
    );
  }

  if (!data) {
    return (
      <Banner
        tone="danger"
        title={
          notFound
            ? t("discovery.features.itemDetail.ui.itemDetailPage.not.found")
            : t("discovery.features.itemDetail.ui.itemDetailPage.error.2")
        }
        description={
          notFound
            ? t("discovery.features.itemDetail.ui.itemDetailPage.this.item.could.not.be.found")
            : t("discovery.features.itemDetail.ui.itemDetailPage.this.item.is.not.available.right")
        }
      />
    );
  }

  return (
    <LoadedItemDetailPage
      key={data.catalog_item_id}
      data={data}
      similarItems={similarItems}
      accountOfferMatches={accountOfferMatches}
      viewerAccountId={viewerAccountId}
      initialMarketIntent={initialMarketIntent}
      initialSelectedListingId={initialSelectedListingId}
      initialSelectedOfferId={initialSelectedOfferId}
      initialSelectedOptions={initialSelectedOptions}
      hasInitialSelectedOptionFilters={hasInitialSelectedOptionFilters}
      renderCommerce={renderCommerce}
    />
  );
}

function LoadedItemDetailPage(
  props: LoadedItemDetailPageProps & Readonly<{ similarItems: readonly DiscoverySimilarItem[] }>,
) {
  const model = useItemDetailPageModel(props);
  const primaryCategory = model.data.categories[0] ?? null;

  return (
    <>
      <Breadcrumbs
        items={[
          { label: t("discovery.features.itemDetail.ui.itemDetailPage.home"), href: "/" },
          primaryCategory
            ? { label: primaryCategory.name, href: `/categories/${primaryCategory.slug}` }
            : { label: t("discovery.features.itemDetail.ui.itemDetailPage.search"), href: "/search" },
          { label: model.data.title },
        ]}
      />

      <Container width="expanded" paddingX={0}>
        <MarketplaceProductDetailLayout
          summary={<ItemDetailSummary data={model.data} />}
          media={<ItemDetailMedia images={model.images} imageFallback={model.imageFallback} />}
          market={
            <Stack gap={4}>
              {model.staleSelectionBanner}
              {model.productOptionSelector}
              <MarketplaceMarketSummary
                priceLabel={
                  model.marketIntent === "sell"
                    ? t("discovery.features.itemDetail.ui.itemDetailPage.best.offer")
                    : t("discovery.features.itemDetail.ui.itemDetailPage.lowest.ask")
                }
                price={model.marketSummaryPrice}
                note={model.marketNote}
                facts={model.marketSummaryFacts}
              />
            </Stack>
          }
          commerce={model.commerce}
          mobileActionBar={model.mobileCommerceActionBar}
        >
          <Stack gap={6}>
            <ItemDetailProductContents data={model.data} />
            <ItemDetailMarketBook
              marketBookTab={model.marketBookTab}
              onMarketBookTabChange={model.setMarketBookTab}
              visibleListings={model.visibleListings}
              itemMarketListings={model.itemMarketListings}
              matchingOffers={model.matchingOffers}
              itemOfferDemandMatches={model.itemOfferDemandMatches}
              hasActiveFilters={model.hasActiveFilters}
              selectedListing={model.selectedListing}
              selectedOffer={model.selectedOffer}
              selectedProductId={model.selectedProductId}
              viewerAccountId={model.viewerAccountId}
              data={model.data}
              detailItems={model.detailItems}
              getProductSelectionDetails={model.getProductSelectionDetails}
              onClearProductFilters={model.clearProductFilters}
              onSelectListing={model.selectMarketListing}
              onSelectOffer={model.selectMarketOffer}
            />
            <ItemDetailSimilarItems items={props.similarItems} />
          </Stack>
        </MarketplaceProductDetailLayout>
        {model.mobileCommerceBottomSheet}
        <ReferenceDetailDialog
          reference={model.selectedReference}
          onOpenChange={(open) => {
            if (!open) {
              model.setSelectedReference(null);
            }
          }}
        />
      </Container>
    </>
  );
}

function ItemDetailSummary({ data }: { data: DiscoveryItemDetail }) {
  return (
    <Stack gap={4}>
      <Stack gap={3}>
        {data.blueprint ? (
          <Text size="sm" weight="semibold" tone="accent">
            {data.blueprint.name}
          </Text>
        ) : null}

        <Stack gap={2}>
          <Heading level={1}>{data.title}</Heading>
          {data.subtitle ? (
            <Text size="lg" tone="secondary">
              {data.subtitle}
            </Text>
          ) : null}
        </Stack>
      </Stack>
    </Stack>
  );
}

type ItemDetailModel = ReturnType<typeof useItemDetailPageModel>;

function ItemDetailMedia({
  images,
  imageFallback,
}: {
  images: ItemDetailModel["images"];
  imageFallback: ItemDetailModel["imageFallback"];
}) {
  return (
    <Stack gap={5}>
      <ImageGallery
        images={images}
        aspectRatio="5/7"
        maxHeightClassName="max-w-[min(100%,17.25rem)] md:max-w-[min(100%,19.25rem)] [--gallery-max-height:27rem]"
        thumbnailPlacement="left"
        fallbackImage={{
          src: imageFallback.url,
          alt: imageFallback.alt,
          srcSet: imageVariantSrcSet(imageFallback, "detail"),
          sizes: "(min-width: 768px) 19.25rem, min(100vw, 17.25rem)",
        }}
        fallbackImageMode={imageFallback.usage}
        emptyState={
          <Stack gap={3} align="center">
            <Surface tone="muted" padding={4}>
              <Icon name="image" size="lg" tone="secondary" />
            </Surface>
            <Stack gap={1} align="center">
              <Text weight="semibold">{t("discovery.features.itemDetail.ui.itemDetailPage.image.coming.soon")}</Text>
              <Text size="sm" tone="secondary">
                {t("discovery.features.itemDetail.ui.itemDetailPage.catalog.imagery.has.not.been.added")}
              </Text>
            </Stack>
          </Stack>
        }
      />
    </Stack>
  );
}
