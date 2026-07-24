import { t } from "@chase-sets/localization";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import {
  Button,
  Card,
  CommerceActionBar,
  CommerceBottomSheet,
  LinkButton,
  ProductOptions,
  SegmentedControl,
  Stack,
  Text,
  formatMarketplaceNumber,
} from "@chase-sets/design-system";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoveryOffer,
} from "../../../support/client-support/contracts";
import { ProductSelector } from "./product-selector";
import {
  formatBuyerCount,
  formatListingCount,
  formatMoney,
  formatOfferCount,
  formatSellerCount,
  getHighestOfferPrice,
  type MarketBookTab,
  type MarketIntent,
  type MarketSelectionSource,
  updateMarketIntentUrl,
} from "../domain/item-detail-market";
import type { ItemDetailCommerceSections } from "./item-detail-page-types";

function productOptionsFromSelectionDetails(selections: readonly { label: ReactNode; value: ReactNode }[]) {
  return selections.map((selection) => ({
    dimensionLabel: selection.label,
    optionLabel: selection.value,
  }));
}

export type ItemDetailPageViewArgs = {
  data: DiscoveryItemDetail;
  marketIntent: MarketIntent;
  setMarketIntent: Dispatch<SetStateAction<MarketIntent>>;
  setMarketBookTab: Dispatch<SetStateAction<MarketBookTab>>;
  activeMobileCommerce: "buy" | "sell" | "watch" | null;
  setActiveMobileCommerce: Dispatch<SetStateAction<"buy" | "sell" | "watch" | null>>;
  selections: Record<string, string>;
  optionSummaries: Record<string, Record<string, string>>;
  onProductSelectionChange: (dimensionId: string, optionId: string) => void;
  trackRailIntentSelected: (nextMarketIntent: MarketIntent, surface: string) => void;
  commerceSections: ItemDetailCommerceSections | null;
  commerceContent: ReactNode;
  hasActiveFilters: boolean;
  matchingOffers: readonly DiscoveryOffer[];
  buyerCount: number;
  sellerCount: number;
  selectedMarketSummary: {
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  };
  selectedListing: DiscoveryMarketListing | null;
  selectedListingSource: MarketSelectionSource;
  selectedOffer: DiscoveryOffer | null;
  selectedOfferSource: MarketSelectionSource;
  selectedProductId: string | null;
  currentOptionSummary: string;
  explicitSelectedProductSummary: string | null;
  explicitSelectedProductSelectionDetails: { label: string; value: string }[];
};

export function buildItemDetailPageView({
  data,
  marketIntent,
  setMarketIntent,
  setMarketBookTab,
  activeMobileCommerce,
  setActiveMobileCommerce,
  selections,
  optionSummaries,
  onProductSelectionChange,
  trackRailIntentSelected,
  commerceSections,
  commerceContent,
  hasActiveFilters,
  matchingOffers,
  buyerCount,
  sellerCount,
  selectedMarketSummary,
  selectedListing,
  selectedListingSource,
  selectedOffer,
  selectedOfferSource,
  selectedProductId,
  currentOptionSummary,
  explicitSelectedProductSummary,
  explicitSelectedProductSelectionDetails,
}: ItemDetailPageViewArgs) {
  const renderMarketIntentControl = (label: string, fullWidth = false) => (
    <SegmentedControl
      label={label}
      fullWidth={fullWidth}
      items={[
        { value: "buy", label: t("discovery.features.itemDetail.ui.itemDetailPage.buy") },
        { value: "sell", label: t("discovery.features.itemDetail.ui.itemDetailPage.sell") },
        { value: "watch", label: commerceSections?.watchLabel ?? t("discovery.features.search.ui.searchPage.watch") },
      ]}
      value={marketIntent}
      onValueChange={(value) => {
        const nextMarketIntent: MarketIntent = value === "sell" ? "sell" : value === "watch" ? "watch" : "buy";
        setMarketIntent(nextMarketIntent);
        setMarketBookTab(nextMarketIntent === "sell" ? "offers" : "listings");
        updateMarketIntentUrl(nextMarketIntent);
        trackRailIntentSelected(nextMarketIntent, "desktop_rail");
      }}
    />
  );
  const commerce = commerceContent ? (
    <Stack gap={3}>
      {commerceSections?.save}
      {renderMarketIntentControl(t("discovery.features.itemDetail.ui.itemDetailPage.choose.market.intent"))}
      {commerceContent}
    </Stack>
  ) : null;
  const marketNote =
    explicitSelectedProductSelectionDetails.length > 0 ? (
      <ProductOptions
        options={productOptionsFromSelectionDetails(explicitSelectedProductSelectionDetails)}
        emptyLabel={explicitSelectedProductSummary ?? undefined}
      />
    ) : marketIntent === "sell" ? (
      (explicitSelectedProductSummary ??
      (hasActiveFilters
        ? t("discovery.features.itemDetail.ui.itemDetailPage.filtered.offers")
        : t("discovery.features.itemDetail.ui.itemDetailPage.all.offers")))
    ) : (
      (explicitSelectedProductSummary ??
      (hasActiveFilters
        ? t("discovery.features.itemDetail.ui.itemDetailPage.filtered.active.listings")
        : t("discovery.features.itemDetail.ui.itemDetailPage.all.active.listings")))
    );
  const marketSummaryPrice =
    marketIntent === "sell"
      ? formatMoney(getHighestOfferPrice(matchingOffers))
      : formatMoney(selectedMarketSummary.lowest_price_amount);
  const mobileCommerceSummary = (
    <Text element="div" weight="semibold" truncate>
      {marketIntent === "buy" && selectedListing ? formatMoney(selectedListing.price_amount) : marketSummaryPrice}
    </Text>
  );
  const marketSummaryFacts =
    marketIntent === "sell"
      ? [
          {
            label: t("discovery.features.itemDetail.ui.itemDetailPage.requested"),
            value: matchingOffers.reduce((sum, offer) => sum + offer.quantity_requested, 0),
          },
          {
            label: t("discovery.features.itemDetail.ui.itemDetailPage.offers"),
            value: formatOfferCount(matchingOffers.length),
          },
          {
            label: t("discovery.features.itemDetail.ui.itemDetailPage.buyers"),
            value: formatBuyerCount(buyerCount),
          },
        ]
      : [
          {
            label: t("discovery.features.itemDetail.ui.itemDetailPage.available"),
            value: formatMarketplaceNumber(
              selectedMarketSummary.total_visible_quantity,
              t("discovery.features.itemDetail.ui.itemDetailPage.unavailable"),
            ),
          },
          {
            label: t("discovery.features.itemDetail.ui.itemDetailPage.listings"),
            value: formatListingCount(selectedMarketSummary.active_listing_count),
          },
          {
            label: t("discovery.features.itemDetail.ui.itemDetailPage.sellers"),
            value: formatSellerCount(sellerCount),
          },
        ];
  const activeMobileCommerceSection = activeMobileCommerce ? commerceSections?.mobile?.[activeMobileCommerce] : null;
  const activeMobileCommerceContent =
    activeMobileCommerceSection?.content ??
    (activeMobileCommerce === "buy"
      ? commerceSections?.buy
      : activeMobileCommerce === "sell"
        ? commerceSections?.sell
        : activeMobileCommerce === "watch"
          ? commerceSections?.watch
          : null);
  const mobileBuySheetTitle = selectedListing
    ? selectedListingSource === "explicit"
      ? t("discovery.features.itemDetail.ui.itemDetailPage.selected.listing")
      : t("discovery.routes.itemDetail.best.available.listing")
    : t("discovery.routes.itemDetail.selected.product");
  const mobileBuySheetDescription = selectedListing
    ? selectedListingSource === "explicit"
      ? t("discovery.routes.itemDetail.mobile.buy.selected.listing.description")
      : t("discovery.routes.itemDetail.mobile.buy.best.available.listing.description")
    : t("discovery.routes.itemDetail.mobile.buy.selected.product.description");
  const mobileSellSheetTitle = selectedOffer
    ? selectedOfferSource === "explicit"
      ? t("discovery.routes.itemDetail.selected.offer.heading")
      : t("discovery.routes.itemDetail.best.offer.heading")
    : t("discovery.routes.itemDetail.selected.product");
  const mobileSellSheetDescription = selectedOffer
    ? selectedOfferSource === "explicit"
      ? t("discovery.routes.itemDetail.mobile.sell.selected.offer.description")
      : t("discovery.routes.itemDetail.mobile.sell.best.offer.description")
    : t("discovery.routes.itemDetail.mobile.sell.selected.product.description");
  const activeMobileCommerceTitle =
    activeMobileCommerceSection?.title ??
    (activeMobileCommerce === "buy"
      ? mobileBuySheetTitle
      : activeMobileCommerce === "watch"
        ? t("discovery.routes.itemDetail.mobile.watch.title")
        : mobileSellSheetTitle);
  const activeMobileCommerceDescription =
    activeMobileCommerceSection?.description ??
    (activeMobileCommerce === "buy"
      ? mobileBuySheetDescription
      : activeMobileCommerce === "watch"
        ? t("discovery.routes.itemDetail.mobile.watch.description")
        : activeMobileCommerce === "sell"
          ? mobileSellSheetDescription
          : undefined);
  const openMobileCommerce = (action: "buy" | "sell" | "watch", nextMarketIntent: MarketIntent) => {
    setMarketIntent(nextMarketIntent);
    setMarketBookTab(nextMarketIntent === "sell" ? "offers" : "listings");
    updateMarketIntentUrl(nextMarketIntent);
    setActiveMobileCommerce(action);
    trackRailIntentSelected(nextMarketIntent, "mobile_action_bar");
  };
  const mobileBuyAction = selectedProductId ? (
    <Button type="button" size="lg" onClick={() => openMobileCommerce("buy", "buy")}>
      {t("discovery.features.itemDetail.ui.itemDetailPage.buy.2")}
    </Button>
  ) : (
    <LinkButton href="#select-options" size="lg">
      {t("discovery.features.itemDetail.ui.itemDetailPage.select.options")}
    </LinkButton>
  );
  const mobileSellAction =
    (commerceSections?.mobile?.sell ?? commerceSections?.sell) ? (
      selectedProductId ? (
        <Button type="button" tone="secondary" size="md" onClick={() => openMobileCommerce("sell", "sell")}>
          {commerceSections.sellLabel ?? t("discovery.features.itemDetail.ui.itemDetailPage.sell.2")}
        </Button>
      ) : (
        <LinkButton href="#select-options" tone="secondary" size="md">
          {t("discovery.features.itemDetail.ui.itemDetailPage.choose.to.sell")}
        </LinkButton>
      )
    ) : null;
  const mobileWatchAction = commerceSections?.mobile?.watch ? (
    selectedProductId ? (
      <Button type="button" tone="secondary" size="md" onClick={() => openMobileCommerce("watch", "watch")}>
        {commerceSections.watchLabel ?? t("discovery.features.itemDetail.ui.itemDetailPage.watch")}
      </Button>
    ) : (
      <LinkButton href="#select-options" tone="secondary" size="md">
        {t("discovery.features.itemDetail.ui.itemDetailPage.choose.to.watch")}
      </LinkButton>
    )
  ) : null;
  const mobileCommerceActionBar = commerce ? (
    <CommerceActionBar
      summary={mobileCommerceSummary}
      primaryAction={mobileBuyAction}
      secondaryAction={mobileSellAction}
      tertiaryAction={mobileWatchAction}
    />
  ) : null;
  const mobileCommerceBottomSheet = commerce ? (
    <CommerceBottomSheet
      open={Boolean(activeMobileCommerce && activeMobileCommerceContent)}
      onOpenChange={(open) => {
        if (!open) {
          setActiveMobileCommerce(null);
        }
      }}
      title={activeMobileCommerceTitle}
      description={activeMobileCommerceDescription}
      footer={activeMobileCommerceSection?.footer}
    >
      {activeMobileCommerceContent}
    </CommerceBottomSheet>
  ) : null;
  const productOptionSelector =
    data.product_schema && data.product_schema.dimensions.length > 0 ? (
      <Card variant="feature">
        <Stack gap={3} id="select-options">
          <Stack gap={1}>
            <Text size="sm" weight="semibold">
              {t("discovery.features.itemDetail.ui.itemDetailPage.choose.options")}
            </Text>
          </Stack>
          <ProductSelector
            schema={data.product_schema}
            selections={selections}
            optionSummaries={optionSummaries}
            onSelectionChange={onProductSelectionChange}
          />
          <Stack gap={1}>
            <Text size="sm" weight="semibold">
              {t("discovery.features.itemDetail.ui.itemDetailPage.chosen.options")}
            </Text>
            <ProductOptions
              options={productOptionsFromSelectionDetails(explicitSelectedProductSelectionDetails)}
              emptyLabel={currentOptionSummary}
              variant="chips"
            />
          </Stack>
        </Stack>
      </Card>
    ) : null;

  return {
    commerce,
    marketNote,
    marketSummaryPrice,
    marketSummaryFacts,
    mobileCommerceActionBar,
    mobileCommerceBottomSheet,
    productOptionSelector,
  };
}
