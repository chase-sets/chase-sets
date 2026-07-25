import { t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import {
  AccountReputationSummary,
  Badge,
  Button,
  ComparisonList,
  ComparisonListCell,
  ComparisonListHeader,
  ComparisonListPrice,
  ComparisonListRow,
  ComparisonListRowGrid,
  Heading,
  Inline,
  KeyValueList,
  LinkButton,
  MarketplaceEmptyState,
  PageSection,
  ProductOptions,
  Stack,
  Tabs,
  Text,
} from "@chase-sets/design-system";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoveryOffer,
} from "../../../support/client-support/contracts";
import { ItemDetailMarketPanel } from "./item-detail-market-panel";
import {
  formatCompactProductSummary,
  formatListingAvailability,
  formatListingPurchaseLimit,
  formatMoney,
  formatOfferRequestedQuantity,
  isBestOffer,
  isLowestPriceListing,
  type MarketBookTab,
  parseRating,
} from "../domain/item-detail-market";

function productOptionsFromSelectionDetails(selections: readonly { label: ReactNode; value: ReactNode }[]) {
  return selections.map((selection) => ({
    dimensionLabel: selection.label,
    optionLabel: selection.value,
  }));
}

function ListingTrustSignal({
  accountName,
  feedbackHref,
  rating,
  reviewCount = 0,
}: {
  accountName: string;
  feedbackHref?: string | null;
  rating?: string | null;
  reviewCount?: number;
}) {
  const parsedRating = parseRating(rating);

  return (
    <AccountReputationSummary
      accountName={accountName}
      href={feedbackHref}
      averageRating={parsedRating}
      reviewCount={reviewCount}
    />
  );
}

function ProductQuantityLine({
  selectionDetails,
  emptyLabel,
  quantity,
  children,
}: {
  selectionDetails: readonly { label: ReactNode; value: ReactNode }[];
  emptyLabel: ReactNode;
  quantity: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Stack gap={1} minWidth="0">
      <ProductOptions
        options={productOptionsFromSelectionDetails(selectionDetails)}
        emptyLabel={emptyLabel}
        variant="compact"
        size="sm"
        truncate
      />
      <Text element="span" size="xs" tone="secondary" weight="medium">
        {quantity}
      </Text>
      {children}
    </Stack>
  );
}

export type ItemDetailMarketBookProps = Readonly<{
  marketBookTab: MarketBookTab;
  onMarketBookTabChange: (tab: MarketBookTab) => void;
  visibleListings: readonly DiscoveryMarketListing[];
  itemMarketListings: readonly DiscoveryMarketListing[];
  matchingOffers: readonly DiscoveryOffer[];
  itemOfferDemandMatches: readonly DiscoveryOffer[];
  hasActiveFilters: boolean;
  selectedListing: DiscoveryMarketListing | null;
  selectedOffer: DiscoveryOffer | null;
  selectedProductId: string | null;
  viewerAccountId: string | null;
  data: DiscoveryItemDetail;
  detailItems: readonly { key: ReactNode; value: ReactNode }[];
  getProductSelectionDetails: (
    options: readonly { dimensionId: string; optionId: string }[],
  ) => { label: string; value: string }[];
  onClearProductFilters: () => void;
  onSelectListing: (listing: DiscoveryMarketListing) => void;
  onSelectOffer: (offer: DiscoveryOffer) => void;
}>;

export function ItemDetailMarketBook({
  marketBookTab,
  onMarketBookTabChange,
  visibleListings,
  itemMarketListings,
  matchingOffers,
  itemOfferDemandMatches,
  hasActiveFilters,
  selectedListing,
  selectedOffer,
  selectedProductId,
  viewerAccountId,
  data,
  detailItems,
  getProductSelectionDetails,
  onClearProductFilters,
  onSelectListing,
  onSelectOffer,
}: ItemDetailMarketBookProps) {
  return (
    <PageSection title={t("discovery.features.itemDetail.ui.itemDetailPage.market.book")}>
      <Tabs
        value={marketBookTab}
        onValueChange={(value) =>
          onMarketBookTabChange(value === "offers" || value === "sales" || value === "details" ? value : "listings")
        }
        items={[
          {
            value: "listings",
            label: t("discovery.features.itemDetail.ui.itemDetailPage.listings.2"),
            content: (
              <Stack gap={3}>
                <Inline gap={2}>
                  <Text size="sm" tone="secondary">
                    {hasActiveFilters
                      ? t("discovery.features.itemDetail.ui.itemDetailPage.filtered.listing.count", {
                          visibleCount: visibleListings.length,
                          totalCount: itemMarketListings.length,
                          listingLabel: t(
                            itemMarketListings.length === 1
                              ? "discovery.features.itemDetail.ui.itemDetailPage.listing.singular"
                              : "discovery.features.itemDetail.ui.itemDetailPage.listing.plural",
                          ),
                        })
                      : t("discovery.features.itemDetail.ui.itemDetailPage.active.listing.count", {
                          count: visibleListings.length,
                          listingLabel: t(
                            visibleListings.length === 1
                              ? "discovery.features.itemDetail.ui.itemDetailPage.listing.singular"
                              : "discovery.features.itemDetail.ui.itemDetailPage.listing.plural",
                          ),
                        })}
                  </Text>
                  {hasActiveFilters ? (
                    <Button type="button" tone="ghost" size="sm" onClick={onClearProductFilters}>
                      {t("discovery.features.itemDetail.ui.itemDetailPage.clear.filters")}
                    </Button>
                  ) : null}
                </Inline>
                {visibleListings.length > 0 ? (
                  <ComparisonList>
                    <ComparisonListHeader
                      labels={[
                        t("discovery.features.itemDetail.ui.itemDetailPage.price"),
                        t("discovery.features.itemDetail.ui.itemDetailPage.seller"),
                        t("discovery.features.itemDetail.ui.itemDetailPage.product"),
                        t("discovery.features.itemDetail.ui.itemDetailPage.action"),
                      ]}
                    />
                    {visibleListings.map((listing) => {
                      const isSelected = selectedListing?.listing_id === listing.listing_id;
                      const purchaseLimit = formatListingPurchaseLimit(listing);
                      const isLowestPrice = isLowestPriceListing(listing, visibleListings);
                      const sellerName =
                        listing.seller_display_name ?? t("discovery.features.itemDetail.ui.itemDetailPage.seller");
                      const sellerFeedbackHref = listing.seller_slug
                        ? `/accounts/${listing.seller_slug}#feedback`
                        : null;
                      const productSelectionDetails = getProductSelectionDetails(listing.selected_options);
                      const compactProductSummary = formatCompactProductSummary(
                        listing.product_summary,
                        productSelectionDetails,
                        t("discovery.features.itemDetail.ui.itemDetailPage.standard"),
                      );

                      return (
                        <ComparisonListRow
                          key={listing.listing_id}
                          selected={isSelected}
                          aria-label={t("discovery.features.itemDetail.ui.itemDetailPage.listing.row.label", {
                            price: formatMoney(listing.price_amount),
                            seller: sellerName,
                          })}
                        >
                          <ComparisonListRowGrid>
                            <ComparisonListCell>
                              <Inline gap={2}>
                                <ComparisonListPrice>{formatMoney(listing.price_amount)}</ComparisonListPrice>
                                {isLowestPrice ? (
                                  <Badge tone="success">
                                    {t("discovery.features.itemDetail.ui.itemDetailPage.lowest.price")}
                                  </Badge>
                                ) : null}
                              </Inline>
                            </ComparisonListCell>
                            <ComparisonListCell area="account">
                              <ListingTrustSignal
                                accountName={sellerName}
                                feedbackHref={sellerFeedbackHref}
                                rating={listing.seller_average_rating}
                                reviewCount={listing.seller_review_count ?? 0}
                              />
                            </ComparisonListCell>
                            <ComparisonListCell area="product">
                              <ProductQuantityLine
                                selectionDetails={productSelectionDetails}
                                emptyLabel={compactProductSummary}
                                quantity={formatListingAvailability(listing)}
                              >
                                {purchaseLimit ? <Badge tone="neutral">{purchaseLimit}</Badge> : null}
                              </ProductQuantityLine>
                            </ComparisonListCell>
                            <ComparisonListCell area="action">
                              <Button
                                type="button"
                                tone={isSelected ? "primary" : "secondary"}
                                size="sm"
                                aria-pressed={isSelected}
                                aria-label={t(
                                  isSelected
                                    ? "discovery.features.itemDetail.ui.itemDetailPage.selected.listing.action"
                                    : "discovery.features.itemDetail.ui.itemDetailPage.select.listing.action",
                                  { seller: sellerName, price: formatMoney(listing.price_amount) },
                                )}
                                leadingIcon={isSelected ? "check" : undefined}
                                onClick={() => onSelectListing(listing)}
                                data-focus-clearance-target
                              >
                                {isSelected
                                  ? t("discovery.features.itemDetail.ui.itemDetailPage.selected")
                                  : t("discovery.features.itemDetail.ui.itemDetailPage.select")}
                              </Button>
                            </ComparisonListCell>
                          </ComparisonListRowGrid>
                        </ComparisonListRow>
                      );
                    })}
                  </ComparisonList>
                ) : (
                  <MarketplaceEmptyState
                    title={t("discovery.features.itemDetail.ui.itemDetailPage.no.active.listings")}
                    description={
                      itemMarketListings.length > 0
                        ? t("discovery.features.itemDetail.ui.itemDetailPage.no.active.listings.match.these.filters")
                        : t("discovery.features.itemDetail.ui.itemDetailPage.sellers.have.not.published.inventory.for")
                    }
                    recoveryActions={
                      <>
                        {selectedProductId ? (
                          <LinkButton href="#make-offer" size="sm">
                            {t("discovery.features.itemDetail.ui.itemDetailPage.make.offer.3")}
                          </LinkButton>
                        ) : (
                          <LinkButton href="#select-options" size="sm">
                            {t("discovery.features.itemDetail.ui.itemDetailPage.choose.options.2")}
                          </LinkButton>
                        )}
                        {hasActiveFilters ? (
                          <Button type="button" tone="secondary" size="sm" onClick={onClearProductFilters}>
                            {t("discovery.features.itemDetail.ui.itemDetailPage.clear.filters.2")}
                          </Button>
                        ) : null}
                      </>
                    }
                  />
                )}
              </Stack>
            ),
          },
          {
            value: "offers",
            label: t("discovery.features.itemDetail.ui.itemDetailPage.offers.2"),
            content: (
              <Stack gap={3}>
                <Inline gap={2}>
                  <Text size="sm" tone="secondary">
                    {t("discovery.features.itemDetail.ui.itemDetailPage.matching.offer.count", {
                      count: matchingOffers.length,
                      offerLabel: t(
                        matchingOffers.length === 1
                          ? "discovery.features.itemDetail.ui.itemDetailPage.offer.singular"
                          : "discovery.features.itemDetail.ui.itemDetailPage.offer.plural",
                      ),
                    })}
                  </Text>
                  {hasActiveFilters ? (
                    <Button type="button" tone="ghost" size="sm" onClick={onClearProductFilters}>
                      {t("discovery.features.itemDetail.ui.itemDetailPage.clear.filters.3")}
                    </Button>
                  ) : null}
                </Inline>
                {matchingOffers.length > 0 ? (
                  <ComparisonList>
                    <ComparisonListHeader
                      labels={[
                        t("discovery.features.itemDetail.ui.itemDetailPage.price"),
                        t("discovery.features.itemDetail.ui.itemDetailPage.buyer"),
                        t("discovery.features.itemDetail.ui.itemDetailPage.product"),
                        t("discovery.features.itemDetail.ui.itemDetailPage.action"),
                      ]}
                    />
                    {matchingOffers.map((offer) => {
                      const isViewerOffer = viewerAccountId !== null && offer.buyer_account_id === viewerAccountId;
                      const isSelected = selectedOffer?.offer_id === offer.offer_id;
                      const isBestOfferPrice = isBestOffer(offer, matchingOffers);
                      const buyerName = offer.buyer_display_name ?? offer.buyer_account_id;
                      const buyerFeedbackHref = offer.buyer_slug ? `/accounts/${offer.buyer_slug}#feedback` : null;
                      const productSelectionDetails = getProductSelectionDetails(offer.selected_options);
                      const compactProductSummary = formatCompactProductSummary(
                        offer.product_summary,
                        productSelectionDetails,
                        t("discovery.features.itemDetail.ui.itemDetailPage.standard.2"),
                      );

                      return (
                        <ComparisonListRow
                          key={offer.offer_id}
                          selected={isSelected}
                          aria-label={t("discovery.features.itemDetail.ui.itemDetailPage.offer.row.label", {
                            price: formatMoney(offer.price_amount),
                            buyer: buyerName,
                          })}
                        >
                          <ComparisonListRowGrid>
                            <ComparisonListCell>
                              <Inline gap={2}>
                                <ComparisonListPrice>{formatMoney(offer.price_amount)}</ComparisonListPrice>
                                {isBestOfferPrice ? (
                                  <Badge tone="success">
                                    {t("discovery.features.itemDetail.ui.itemDetailPage.best.offer")}
                                  </Badge>
                                ) : null}
                                {isViewerOffer ? (
                                  <Badge tone="accent">
                                    {t("discovery.features.itemDetail.ui.itemDetailPage.your.offer")}
                                  </Badge>
                                ) : null}
                              </Inline>
                            </ComparisonListCell>
                            <ComparisonListCell area="account">
                              <AccountReputationSummary
                                accountName={buyerName}
                                href={buyerFeedbackHref}
                                averageRating={offer.buyer_average_rating}
                                reviewCount={offer.buyer_review_count ?? 0}
                                ratingLabel={t("discovery.features.itemDetail.ui.itemDetailPage.buyer.reputation")}
                                onLinkClick={(event) => event.stopPropagation()}
                              />
                              {isViewerOffer ? (
                                <Text size="xs" tone="secondary">
                                  {t("discovery.features.itemDetail.ui.itemDetailPage.own.offer.visibility")}
                                </Text>
                              ) : null}
                            </ComparisonListCell>
                            <ComparisonListCell area="product">
                              <ProductQuantityLine
                                selectionDetails={productSelectionDetails}
                                emptyLabel={compactProductSummary}
                                quantity={formatOfferRequestedQuantity(offer)}
                              />
                            </ComparisonListCell>
                            <ComparisonListCell area="action">
                              <Button
                                type="button"
                                tone={isSelected ? "primary" : "secondary"}
                                size="sm"
                                aria-pressed={isSelected}
                                aria-label={t(
                                  isSelected
                                    ? "discovery.features.itemDetail.ui.itemDetailPage.selected.offer.action"
                                    : "discovery.features.itemDetail.ui.itemDetailPage.select.offer.action",
                                  { buyer: buyerName, price: formatMoney(offer.price_amount) },
                                )}
                                leadingIcon={isSelected ? "check" : undefined}
                                onClick={() => onSelectOffer(offer)}
                                data-focus-clearance-target
                              >
                                {isSelected
                                  ? t("discovery.features.itemDetail.ui.itemDetailPage.selected")
                                  : t("discovery.features.itemDetail.ui.itemDetailPage.select")}
                              </Button>
                            </ComparisonListCell>
                          </ComparisonListRowGrid>
                        </ComparisonListRow>
                      );
                    })}
                  </ComparisonList>
                ) : (
                  <MarketplaceEmptyState
                    title={t("discovery.features.itemDetail.ui.itemDetailPage.no.matching.offers")}
                    description={
                      itemOfferDemandMatches.length > 0
                        ? t("discovery.features.itemDetail.ui.itemDetailPage.no.offers.match.these.filters")
                        : t("discovery.features.itemDetail.ui.itemDetailPage.buyers.have.not.placed.offers.for")
                    }
                  />
                )}
              </Stack>
            ),
          },
          {
            value: "sales",
            label: t("discovery.features.itemDetail.ui.itemDetailPage.sales"),
            content: (
              <ItemDetailMarketPanel
                catalogItemId={data.catalog_item_id}
                productId={selectedProductId}
                itemTitle={data.title}
              />
            ),
          },
          {
            value: "details",
            label: t("discovery.features.itemDetail.ui.itemDetailPage.details"),
            content:
              data.description || detailItems.length > 0 ? (
                <Stack gap={4}>
                  {data.description ? (
                    <Stack gap={2}>
                      <Heading level={3}>{t("discovery.features.itemDetail.ui.itemDetailPage.description")}</Heading>
                      <Text>{data.description}</Text>
                    </Stack>
                  ) : null}
                  {detailItems.length > 0 ? <KeyValueList density="compact" items={[...detailItems]} /> : null}
                </Stack>
              ) : (
                <MarketplaceEmptyState
                  title={t("discovery.features.itemDetail.ui.itemDetailPage.details")}
                  description={t("discovery.features.itemDetail.ui.itemDetailPage.no.additional.details")}
                />
              ),
          },
        ]}
      />
    </PageSection>
  );
}
