import { formatBpsPercent, formatDateTime, t } from "@chase-sets/localization";
import { useEffect, type FormEvent, type ReactNode } from "react";
import {
  HiddenInput,
  Form,
  AccountReputationSummary,
  Badge,
  Button,
  FormPanel,
  type FormPanelVariant,
  Inline,
  KeyValueList,
  NumberInput,
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
  submittedButtonValue,
} from "./commerce-primitives";

export function MarketplaceOfferMatchSection({
  formId = "sell-box",
  panelVariant = "card",
  showSummary = panelVariant === "card",
  actions,
  actionMode = "all",
  selectedOffer,
  selectedOfferSource = "explicit",
  sellNowIntent = "sell-now",
  productId,
  productSelectionDetails = [],
  productSummary,
  matchingOfferCount,
  errorMessage,
}: {
  formId?: string;
  panelVariant?: FormPanelVariant;
  showSummary?: boolean;
  actions?: ReactNode;
  actionMode?: "all" | "sell-now" | "add-to-sell-list";
  selectedOffer: {
    offer_id: string;
    buyer_display_name: string | null;
    buyer_account_id: string;
    price_amount: string;
    quantity_requested: number;
    seller_available_quantity?: number | null;
    can_fulfill?: boolean;
    in_sell_list?: boolean;
    product_summary?: string | null;
    buyer_slug?: string | null;
    buyer_average_rating?: string | null;
    buyer_review_count?: number;
    acceptance_terms?: MarketplaceListingTermsPreview | null;
  } | null;
  selectedOfferSource?: MarketSelectionSource;
  sellNowIntent?: "sell-now" | "add-to-sell-list";
  productId: string | null;
  productSelectionDetails?: readonly ProductSelectionDisplayDetail[];
  productSummary?: string | null;
  matchingOfferCount: number;
  errorMessage?: string | null;
}) {
  const acceptedQuantity = selectedOffer?.quantity_requested ?? 0;
  const acceptedValue = selectedOffer ? multiplyMoneyAmount(selectedOffer.price_amount, acceptedQuantity) : null;
  const acceptanceTerms = selectedOffer?.acceptance_terms ?? null;
  const marketplaceFeeTotal =
    selectedOffer && acceptanceTerms
      ? multiplyMoneyAmount(acceptanceTerms.marketplace_sales_fee_unit_amount, acceptedQuantity)
      : null;
  const sellerNetTotal =
    selectedOffer && acceptanceTerms
      ? multiplyMoneyAmount(acceptanceTerms.seller_net_unit_amount, acceptedQuantity)
      : null;
  const shippingAllowanceAmount =
    acceptanceTerms && acceptedValue !== null
      ? (acceptedValue * acceptanceTerms.shipping_allowance_percentage_bps) / 10000
      : null;
  const quoteTime = acceptanceTerms ? formatDateTime(acceptanceTerms.resolved_at) : null;
  const termsSource = acceptanceTerms
    ? formatTermsSource(acceptanceTerms)
    : t("discovery.routes.itemDetail.standard.terms");
  const selectedOfferBuyerName = selectedOffer?.buyer_display_name?.trim();
  const selectedOfferBuyer = selectedOfferBuyerName || t("discovery.features.itemDetail.ui.itemDetailPage.buyer");
  const selectedOfferBuyerHref = selectedOffer?.buyer_slug ? `/accounts/${selectedOffer.buyer_slug}#feedback` : null;
  const selectedOfferCanFulfill = selectedOffer ? (selectedOffer.can_fulfill ?? true) : false;
  const selectedOfferInSellList = Boolean(selectedOffer?.in_sell_list);
  const showFulfillmentStatus = typeof selectedOffer?.can_fulfill === "boolean";
  const selectedOfferAvailableQuantity = selectedOffer?.seller_available_quantity;
  const selectedOfferReferenceInfo =
    actionMode === "add-to-sell-list"
      ? {
          analyticsTopic: "offer_sell_list",
          triggerLabel: t("discovery.routes.itemDetail.referenceInfo.offerSellList.trigger"),
          ariaLabel: t("discovery.routes.itemDetail.referenceInfo.offerSellList.aria"),
          title: t("discovery.routes.itemDetail.referenceInfo.offerSellList.title"),
          summary: t("discovery.routes.itemDetail.referenceInfo.offerSellList.summary"),
          lines: [
            t("discovery.routes.itemDetail.referenceInfo.offerSellList.line1"),
            t("discovery.routes.itemDetail.referenceInfo.offerSellList.line2"),
          ],
        }
      : {
          analyticsTopic: actionMode === "sell-now" ? "accept_offer" : "estimated_payout",
          triggerLabel: t("discovery.routes.itemDetail.referenceInfo.estimatedPayout.trigger"),
          ariaLabel: t("discovery.routes.itemDetail.referenceInfo.estimatedPayout.aria"),
          title: t("discovery.routes.itemDetail.referenceInfo.estimatedPayout.title"),
          summary: t("discovery.routes.itemDetail.referenceInfo.estimatedPayout.summary", {
            source: termsSource,
          }),
          lines: [
            t("discovery.routes.itemDetail.referenceInfo.estimatedPayout.line1"),
            t("discovery.routes.itemDetail.referenceInfo.estimatedPayout.line2"),
            t("discovery.routes.itemDetail.referenceInfo.acceptOffer.line1"),
            t("discovery.routes.itemDetail.referenceInfo.offerSellList.line1"),
            t("discovery.routes.itemDetail.referenceInfo.offerSellList.line2"),
          ],
        };
  const offerMatchWorkflow = selectedOfferSource === "explicit" ? "selected_offer" : "best_offer";
  const hasAcceptanceTerms = Boolean(acceptanceTerms);
  useEffect(() => {
    if (!selectedOffer) {
      return;
    }

    trackItemDetailRailEvent(hasAcceptanceTerms ? "payout_preview_shown" : "standard_preview_unavailable", {
      intent: "sell",
      workflow: offerMatchWorkflow,
      selection: selectedOfferSource,
      topic: "estimated_payout",
      outcome: hasAcceptanceTerms ? "shown" : "unavailable",
      surface: "action_rail",
    });
  }, [hasAcceptanceTerms, offerMatchWorkflow, selectedOffer, selectedOfferSource]);
  useEffect(() => {
    if (!errorMessage) {
      return;
    }

    trackItemDetailRailEvent("validation_failed", {
      intent: "sell",
      workflow: offerMatchWorkflow,
      selection: selectedOfferSource,
      outcome: "form_error",
      surface: "action_rail",
    });
  }, [errorMessage, offerMatchWorkflow, selectedOfferSource]);
  function trackOfferMatchSubmit(event: FormEvent<HTMLFormElement>) {
    const submittedValue = submittedButtonValue(event);
    const isSellList = submittedValue === "add-to-sell-list" || actionMode === "add-to-sell-list";

    trackItemDetailRailEvent("intent_submit_started", {
      intent: "sell",
      workflow: offerMatchWorkflow,
      selection: selectedOfferSource,
      topic: isSellList ? "offer_sell_list" : "accept_offer",
      gate: isSellList ? "sell_list" : "commit",
      surface: "action_rail",
    });
  }
  const sellNowAction = (
    <Button type="submit" name="intent" value={sellNowIntent} disabled={!selectedOfferCanFulfill} block>
      {t("discovery.routes.itemDetail.sell.now")}
    </Button>
  );
  const addToSellListAction = (
    <Button
      type="submit"
      name="intent"
      value="add-to-sell-list"
      tone={actionMode === "add-to-sell-list" && selectedOfferCanFulfill ? "primary" : "secondary"}
      disabled={!selectedOfferCanFulfill || selectedOfferInSellList}
      block
    >
      {selectedOfferInSellList
        ? t("discovery.routes.itemDetail.in.sell.list")
        : t("discovery.routes.itemDetail.add.to.sell.list")}
    </Button>
  );
  const defaultActions =
    actionMode === "sell-now" ? (
      sellNowAction
    ) : actionMode === "add-to-sell-list" ? (
      addToSellListAction
    ) : (
      <>
        {sellNowAction}
        {addToSellListAction}
      </>
    );
  const form = (
    <Form spacing="none" id={formId} method="post" onSubmit={trackOfferMatchSubmit}>
      <Stack gap={3}>
        <HiddenInput type="hidden" name="offerId" value={selectedOffer?.offer_id ?? ""} />
        <HiddenInput
          type="hidden"
          name="feeQuoteFingerprint"
          value={selectedOffer?.acceptance_terms?.fee_quote_fingerprint ?? ""}
        />
        {showSummary ? (
          <Stack gap={1}>
            <Text weight="semibold">
              {selectedOfferSource === "explicit"
                ? t("discovery.routes.itemDetail.selected.offer.heading")
                : t("discovery.routes.itemDetail.best.offer.heading")}
            </Text>
            {selectedOffer ? (
              <>
                <Stack gap={1}>
                  <Inline gap={2}>
                    <Text weight="semibold">
                      {t("discovery.routes.itemDetail.offer.total", {
                        amount: formatMoneyAmount(acceptedValue),
                      })}
                    </Text>
                    {showFulfillmentStatus ? (
                      <Badge tone={selectedOfferCanFulfill ? "success" : "warning"}>
                        {selectedOfferCanFulfill
                          ? t("discovery.routes.itemDetail.can.fulfill")
                          : t("discovery.routes.itemDetail.needs.supply")}
                      </Badge>
                    ) : null}
                  </Inline>
                  <AccountReputationSummary
                    accountName={selectedOfferBuyer}
                    href={selectedOfferBuyerHref}
                    averageRating={selectedOffer.buyer_average_rating}
                    reviewCount={selectedOffer.buyer_review_count ?? 0}
                    ratingLabel="Buyer account reputation"
                  />
                  <ProductOptions
                    options={productOptionsFromSelectionDetails(productSelectionDetails)}
                    emptyLabel={selectedOffer.product_summary ?? productSummary ?? "Selected product"}
                  />
                </Stack>
                {acceptanceTerms ? (
                  <>
                    <KeyValueList
                      density="compact"
                      variant="plain"
                      items={[
                        {
                          key: t("discovery.routes.itemDetail.requested"),
                          value:
                            typeof selectedOfferAvailableQuantity === "number"
                              ? t("discovery.routes.itemDetail.requested.available.summary", {
                                  requested: selectedOffer.quantity_requested,
                                  available: selectedOfferAvailableQuantity,
                                })
                              : t("discovery.routes.itemDetail.requested.count", {
                                  count: selectedOffer.quantity_requested,
                                }),
                        },
                        {
                          key: t("discovery.routes.itemDetail.seller.payout"),
                          value: t("discovery.routes.itemDetail.seller.payout.after.fee", {
                            payout: formatMoneyAmount(sellerNetTotal),
                            fee: formatMoneyAmount(marketplaceFeeTotal),
                          }),
                        },
                        {
                          key: t("discovery.routes.itemDetail.shipping.allowance"),
                          value: t("discovery.routes.itemDetail.shipping.allowance.amount", {
                            amount: formatMoneyAmount(shippingAllowanceAmount),
                            percentage: formatBpsPercent(acceptanceTerms.shipping_allowance_percentage_bps),
                          }),
                        },
                      ]}
                    />
                    <RailReferenceInfo
                      {...selectedOfferReferenceInfo}
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
                                percentage: formatBpsPercent(acceptanceTerms.shipping_allowance_percentage_bps),
                              }),
                            },
                            {
                              key: t("discovery.routes.itemDetail.referenceInfo.termsSource"),
                              value: termsSource,
                            },
                            {
                              key: t("discovery.routes.itemDetail.referenceInfo.quoteTime"),
                              value: quoteTime ?? t("discovery.routes.itemDetail.just.now"),
                            },
                          ],
                        },
                      ]}
                    />
                  </>
                ) : (
                  <Text size="sm" tone="secondary">
                    {t("discovery.routes.itemDetail.offer.terms.calculated.before.acceptance")}
                  </Text>
                )}
              </>
            ) : (
              <Text size="sm" tone="secondary">
                {!productId
                  ? t("discovery.routes.itemDetail.choose.options.to.review.matching.offers")
                  : matchingOfferCount > 0
                    ? t("discovery.routes.itemDetail.matching.offers.need.more.active.supply")
                    : t("discovery.routes.itemDetail.no.offers.match.this.product.yet")}
              </Text>
            )}
          </Stack>
        ) : null}
        {errorMessage ? <Text>{errorMessage}</Text> : null}
        {actions !== undefined ? actions : defaultActions}
      </Stack>
    </Form>
  );

  return (
    <FormPanel variant={panelVariant} glow={Boolean(selectedOffer?.can_fulfill)}>
      {form}
    </FormPanel>
  );
}

export function ProductSellListIntentSection({
  formId = "product-sell-list-box",
  panelVariant = "card",
  showSummary = panelVariant === "card",
  catalogItemId,
  productId,
  itemTitle,
  selectedOptions,
  productSelectionDetails = [],
  productSummary,
  errorMessage,
}: {
  formId?: string;
  panelVariant?: FormPanelVariant;
  showSummary?: boolean;
  catalogItemId: string;
  productId: string | null;
  itemTitle: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSelectionDetails?: readonly ProductSelectionDisplayDetail[];
  productSummary: string | null;
  errorMessage?: string | null;
}) {
  useEffect(() => {
    if (!errorMessage) {
      return;
    }

    trackItemDetailRailEvent("validation_failed", {
      intent: "sell",
      workflow: "selected_product",
      topic: "product_sell_list",
      outcome: "form_error",
      surface: "action_rail",
    });
  }, [errorMessage]);

  return (
    <FormPanel variant={panelVariant} glow={Boolean(productId)}>
      <Form
        spacing="none"
        id={formId}
        method="post"
        onSubmit={() => {
          trackItemDetailRailEvent("intent_submit_started", {
            intent: "sell",
            workflow: "selected_product",
            topic: "product_sell_list",
            surface: "action_rail",
          });
        }}
      >
        <Stack gap={3}>
          <HiddenInput type="hidden" name="intent" value="add-product-to-sell-list" />
          <HiddenInput type="hidden" name="catalogItemId" value={catalogItemId} />
          <HiddenInput type="hidden" name="productId" value={productId ?? ""} />
          <HiddenInput type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
          <HiddenInput type="hidden" name="productSummary" value={productSummary ?? ""} />
          {showSummary ? (
            <Stack gap={2}>
              <Text weight="semibold">{t("discovery.routes.itemDetail.add.product.to.sell.list")}</Text>
              <ProductOptions
                options={productOptionsFromSelectionDetails(productSelectionDetails)}
                emptyLabel={productSummary ?? itemTitle}
                variant={productSelectionDetails.length === 0 ? "chips" : "inline"}
              />
              <RailReferenceInfo
                analyticsTopic="product_sell_list"
                triggerLabel={t("discovery.routes.itemDetail.referenceInfo.productSellList.trigger")}
                ariaLabel={t("discovery.routes.itemDetail.referenceInfo.productSellList.aria")}
                title={t("discovery.routes.itemDetail.referenceInfo.productSellList.title")}
                summary={t("discovery.routes.itemDetail.referenceInfo.productSellList.summary")}
                lines={[
                  t("discovery.routes.itemDetail.referenceInfo.productSellList.line1"),
                  t("discovery.routes.itemDetail.referenceInfo.productSellList.line2"),
                ]}
              />
            </Stack>
          ) : null}
          <NumberInput
            label={t("discovery.routes.itemDetail.quantity")}
            name="quantity"
            min="1"
            defaultValue="1"
            required
          />
          {errorMessage ? <Text>{errorMessage}</Text> : null}
          <Button type="submit" disabled={!productId} block>
            {t("discovery.routes.itemDetail.add.product.to.sell.list")}
          </Button>
        </Stack>
      </Form>
    </FormPanel>
  );
}
