import { formatBpsPercent, formatDateTime, t } from "@chase-sets/localization";
import { useEffect } from "react";
import {
  AccountReputationSummary,
  Badge,
  FormPanel,
  type FormPanelVariant,
  Inline,
  KeyValueList,
  LinkButton,
  ProductOptions,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { trackItemDetailRailEvent } from "../item-detail-rail-analytics";
import {
  formatMoneyAmount,
  formatTermsSource,
  type MarketplaceListingTermsPreview,
  type MarketSelectionSource,
  multiplyMoneyAmount,
  productOptionsFromSelectionDetails,
  type ProductSelectionDisplayDetail,
  RailReferenceInfo,
} from "./commerce-primitives";

export function MarketplaceSellerRegistrationSection({
  panelVariant = "card",
  showSummary = panelVariant === "card",
  mode = "combined",
  productSummary,
  productSelectionDetails = [],
  selectedOffer,
  selectedOfferSource = "explicit",
  matchingOfferCount,
  registerHref,
}: {
  panelVariant?: FormPanelVariant;
  showSummary?: boolean;
  mode?: "combined" | "offer" | "listing";
  productSummary: string | null;
  productSelectionDetails?: readonly ProductSelectionDisplayDetail[];
  selectedOffer?: {
    buyer_display_name: string | null;
    buyer_account_id: string;
    buyer_slug?: string | null;
    buyer_average_rating?: string | null;
    buyer_review_count?: number;
    price_amount: string;
    quantity_requested: number;
    public_standard_terms_preview?: MarketplaceListingTermsPreview | null;
  } | null;
  selectedOfferSource?: MarketSelectionSource;
  matchingOfferCount?: number;
  registerHref: string;
}) {
  const selectedOfferQuote = selectedOffer?.public_standard_terms_preview ?? null;
  const acceptedQuantity = selectedOffer?.quantity_requested ?? 0;
  const acceptedValue = selectedOffer ? multiplyMoneyAmount(selectedOffer.price_amount, acceptedQuantity) : null;
  const marketplaceFeeTotal =
    selectedOffer && selectedOfferQuote
      ? multiplyMoneyAmount(selectedOfferQuote.marketplace_sales_fee_unit_amount, acceptedQuantity)
      : null;
  const sellerNetTotal =
    selectedOffer && selectedOfferQuote
      ? multiplyMoneyAmount(selectedOfferQuote.seller_net_unit_amount, acceptedQuantity)
      : null;
  const shippingAllowanceAmount =
    selectedOfferQuote && acceptedValue !== null
      ? (acceptedValue * selectedOfferQuote.shipping_allowance_percentage_bps) / 10000
      : null;
  const selectedOfferQuoteSource = selectedOfferQuote
    ? formatTermsSource(selectedOfferQuote)
    : t("discovery.routes.itemDetail.standard.terms");
  const selectedOfferQuoteTime = selectedOfferQuote ? formatDateTime(selectedOfferQuote.resolved_at) : null;
  const hasSelectedOfferQuote = Boolean(selectedOfferQuote);
  useEffect(() => {
    if (!selectedOffer) {
      return;
    }

    trackItemDetailRailEvent(hasSelectedOfferQuote ? "payout_preview_shown" : "standard_preview_unavailable", {
      intent: "sell",
      workflow: selectedOfferSource === "explicit" ? "selected_offer" : "best_offer",
      selection: selectedOfferSource,
      topic: "estimated_payout",
      outcome: hasSelectedOfferQuote ? "shown" : "unavailable",
      surface: "guest_registration",
    });
  }, [hasSelectedOfferQuote, selectedOffer, selectedOfferSource]);
  const selectedOfferBuyerName = selectedOffer?.buyer_display_name?.trim();
  const selectedOfferBuyer = selectedOfferBuyerName || t("discovery.features.itemDetail.ui.itemDetailPage.buyer");
  const selectedOfferBuyerHref = selectedOffer?.buyer_slug ? `/accounts/${selectedOffer.buyer_slug}#feedback` : null;
  const selectedOfferWorkflow = selectedOfferSource === "explicit" ? "selected_offer" : "best_offer";
  const showsOfferRegistrationGate = Boolean(selectedOffer && mode !== "listing");
  const showsListingRegistrationGate =
    mode === "listing" || mode === "combined" || (mode === "offer" && !selectedOffer);

  useEffect(() => {
    if (showsOfferRegistrationGate) {
      trackItemDetailRailEvent("registration_gate_shown", {
        intent: "sell",
        workflow: selectedOfferWorkflow,
        gate: "accept_offer",
        viewer: "guest",
        surface: "action_rail",
      });
    }

    if (showsListingRegistrationGate) {
      trackItemDetailRailEvent("registration_gate_shown", {
        intent: "sell",
        workflow: "create_listing",
        gate: "create_listing",
        viewer: "guest",
        surface: "action_rail",
      });
    }
  }, [selectedOfferWorkflow, showsListingRegistrationGate, showsOfferRegistrationGate]);
  const offerRegistrationPanel = selectedOffer ? (
    <FormPanel variant={panelVariant} glow>
      <Stack gap={3}>
        {showSummary ? (
          <Stack gap={1}>
            <Text weight="semibold">
              {selectedOfferSource === "explicit"
                ? t("discovery.routes.itemDetail.selected.offer.heading")
                : t("discovery.routes.itemDetail.best.offer.heading")}
            </Text>
            <Stack gap={1}>
              <Inline gap={2}>
                <Text weight="semibold">
                  {t("discovery.routes.itemDetail.offer.total", {
                    amount: formatMoneyAmount(acceptedValue),
                  })}
                </Text>
                {matchingOfferCount ? (
                  <Badge tone="accent">
                    {t("discovery.routes.itemDetail.available.offer.count", {
                      count: matchingOfferCount,
                    })}
                  </Badge>
                ) : null}
              </Inline>
              <AccountReputationSummary
                accountName={selectedOfferBuyer}
                href={selectedOfferBuyerHref}
                averageRating={selectedOffer.buyer_average_rating}
                reviewCount={selectedOffer.buyer_review_count ?? 0}
                ratingLabel={t("discovery.features.itemDetail.ui.itemDetailPage.buyer.reputation")}
              />
            </Stack>
            <KeyValueList
              density="compact"
              variant="plain"
              items={
                selectedOfferQuote
                  ? [
                      {
                        key: t("discovery.routes.itemDetail.requested"),
                        value: t("discovery.routes.itemDetail.requested.count", {
                          count: selectedOffer.quantity_requested,
                        }),
                      },
                      {
                        key: t("discovery.routes.itemDetail.seller.payout"),
                        value: formatMoneyAmount(sellerNetTotal),
                      },
                      {
                        key: t("discovery.routes.itemDetail.product"),
                        value: (
                          <ProductOptions
                            options={productOptionsFromSelectionDetails(productSelectionDetails)}
                            emptyLabel={
                              productSummary ?? t("discovery.routes.itemDetail.choose.options.to.sell.this.item")
                            }
                          />
                        ),
                      },
                    ]
                  : [
                      {
                        key: t("discovery.routes.itemDetail.requested"),
                        value: t("discovery.routes.itemDetail.requested.count", {
                          count: selectedOffer.quantity_requested,
                        }),
                      },
                      {
                        key: t("discovery.routes.itemDetail.product"),
                        value: (
                          <ProductOptions
                            options={productOptionsFromSelectionDetails(productSelectionDetails)}
                            emptyLabel={
                              productSummary ?? t("discovery.routes.itemDetail.choose.options.to.sell.this.item")
                            }
                          />
                        ),
                      },
                    ]
              }
            />
            {!selectedOfferQuote ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.public.standard.terms.preview.unavailable")}
              </Text>
            ) : null}
            {selectedOfferQuote ? (
              <RailReferenceInfo
                analyticsTopic="estimated_payout"
                triggerLabel={t("discovery.routes.itemDetail.referenceInfo.estimatedPayout.trigger")}
                ariaLabel={t("discovery.routes.itemDetail.referenceInfo.estimatedPayout.aria")}
                title={t("discovery.routes.itemDetail.referenceInfo.estimatedPayout.title")}
                summary={t("discovery.routes.itemDetail.referenceInfo.estimatedPayout.summary", {
                  source: selectedOfferQuoteSource,
                })}
                sections={[
                  {
                    title: t("discovery.routes.itemDetail.referenceInfo.estimatedPayout.facts"),
                    items: [
                      {
                        key: t("discovery.routes.itemDetail.referenceInfo.marketplaceFee"),
                        value: formatMoneyAmount(marketplaceFeeTotal),
                      },
                      {
                        key: t("discovery.routes.itemDetail.shipping.allowance"),
                        value: t("discovery.routes.itemDetail.shipping.allowance.amount", {
                          amount: formatMoneyAmount(shippingAllowanceAmount),
                          percentage: formatBpsPercent(selectedOfferQuote.shipping_allowance_percentage_bps),
                        }),
                      },
                      {
                        key: t("discovery.routes.itemDetail.referenceInfo.termsSource"),
                        value: selectedOfferQuoteSource,
                      },
                      {
                        key: t("discovery.routes.itemDetail.referenceInfo.quoteTime"),
                        value: selectedOfferQuoteTime ?? t("discovery.routes.itemDetail.just.now"),
                      },
                    ],
                  },
                ]}
                lines={[
                  t("discovery.routes.itemDetail.referenceInfo.estimatedPayout.line1"),
                  t("discovery.routes.itemDetail.referenceInfo.estimatedPayout.line2"),
                  t("discovery.routes.itemDetail.referenceInfo.acceptOffer.line1"),
                ]}
              />
            ) : null}
          </Stack>
        ) : null}
        <LinkButton
          href={registerHref}
          leadingIcon="plus"
          block
          onClick={() => {
            trackItemDetailRailEvent("registration_started", {
              intent: "sell",
              workflow: selectedOfferWorkflow,
              gate: "accept_offer",
              viewer: "guest",
              surface: "action_rail",
            });
          }}
        >
          {t("discovery.routes.itemDetail.sign.in.or.register.to.accept.offer")}
        </LinkButton>
      </Stack>
    </FormPanel>
  ) : null;
  const listingRegistrationPanel = (
    <FormPanel variant={panelVariant} glow={!selectedOffer}>
      <Stack gap={3}>
        {showSummary ? (
          <Stack gap={1}>
            <Text weight="semibold">
              {selectedOffer
                ? t("discovery.routes.itemDetail.create.listing.after.registration")
                : t("discovery.routes.itemDetail.sell.on.chase.sets")}
            </Text>
            <KeyValueList
              density="compact"
              variant="plain"
              items={[
                {
                  key: t("discovery.routes.itemDetail.product"),
                  value: (
                    <ProductOptions
                      options={productOptionsFromSelectionDetails(productSelectionDetails)}
                      emptyLabel={productSummary ?? t("discovery.routes.itemDetail.choose.options.to.sell.this.item")}
                    />
                  ),
                },
                {
                  key: t("discovery.routes.itemDetail.asking.price"),
                  value: t("discovery.routes.itemDetail.set.after.registration"),
                },
                {
                  key: t("discovery.routes.itemDetail.inventory"),
                  value: t("discovery.routes.itemDetail.confirm.after.registration"),
                },
              ]}
            />
            <RailReferenceInfo
              analyticsTopic="create_listing"
              triggerLabel={t("discovery.routes.itemDetail.referenceInfo.createListing.trigger")}
              ariaLabel={t("discovery.routes.itemDetail.referenceInfo.createListing.aria")}
              title={t("discovery.routes.itemDetail.referenceInfo.createListing.title")}
              summary={t("discovery.routes.itemDetail.referenceInfo.createListing.summary")}
              lines={[
                t("discovery.routes.itemDetail.referenceInfo.createListing.line1"),
                t("discovery.routes.itemDetail.referenceInfo.createListing.line2"),
              ]}
            />
            {!selectedOffer && !productSummary ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.choose.product.options.first.then.register")}
              </Text>
            ) : null}
          </Stack>
        ) : null}
        <LinkButton
          href={registerHref}
          leadingIcon="plus"
          block
          onClick={() => {
            trackItemDetailRailEvent("registration_started", {
              intent: "sell",
              workflow: "create_listing",
              gate: "create_listing",
              viewer: "guest",
              surface: "action_rail",
            });
          }}
        >
          {selectedOffer
            ? t("discovery.routes.itemDetail.sign.in.or.register.to.list")
            : t("discovery.routes.itemDetail.register.to.sell")}
        </LinkButton>
      </Stack>
    </FormPanel>
  );

  if (mode === "offer") {
    return offerRegistrationPanel ?? listingRegistrationPanel;
  }

  if (mode === "listing") {
    return listingRegistrationPanel;
  }

  return selectedOffer ? (
    <Stack gap={4}>
      {offerRegistrationPanel}
      {listingRegistrationPanel}
    </Stack>
  ) : (
    listingRegistrationPanel
  );
}
