import { t } from "@chase-sets/localization";
import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { useFetcher } from "react-router";
import {
  HiddenInput,
  Form,
  AccountReputationSummary,
  Badge,
  Banner,
  Button,
  FormPanel,
  type FormPanelVariant,
  Inline,
  LinkButton,
  LinkText,
  NumberInput,
  ProductOptions,
  OrderProtectionBadge,
  Stack,
  SecurePaymentCue,
  Text,
} from "@chase-sets/design-system";
import { trackItemDetailRailEvent } from "../item-detail-rail-analytics";
import type { DiscoveryGradedCardDetails } from "../../../../support/client-support/contracts";
import { hasTrustedSellerBadge, TrustedSellerBadge } from "../account-badges";
import {
  formatMoneyAmount,
  getActionErrorMessage,
  isAddToCartActionData,
  type ItemDetailActionData,
  type MarketSelectionSource,
  notifyCartCountChanged,
  ProductQuantitySummary,
  productOptionsFromSelectionDetails,
  type ProductSelectionDisplayDetail,
  parseQuantity,
  RailReferenceInfo,
  submittedButtonValue,
} from "./commerce-primitives";

function gradingCertLookupUrl(gradedCard: DiscoveryGradedCardDetails): string | null {
  const explicitUrl = gradedCard.registryVerification?.lookupUrl?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  const certificationNumber = gradedCard.certificationNumber?.trim();
  if (!certificationNumber) {
    return null;
  }

  switch (gradedCard.gradingCompany.trim().toUpperCase()) {
    case "PSA":
      return `https://www.psacard.com/cert/${encodeURIComponent(certificationNumber)}`;
    case "CGC":
      return `https://www.cgccards.com/certlookup/${encodeURIComponent(certificationNumber)}/`;
    default:
      return null;
  }
}

function GradingCertificationSummary({ gradedCard }: { gradedCard: DiscoveryGradedCardDetails }) {
  const isVerified = gradedCard.registryVerification?.state === "verified";
  const lookupUrl = gradingCertLookupUrl(gradedCard);
  const certLabel = gradedCard.certificationNumber
    ? t("discovery.routes.itemDetail.grading.cert.summary", {
        company: gradedCard.gradingCompany,
        grade: gradedCard.grade,
        cert: gradedCard.certificationNumber,
      })
    : t("discovery.routes.itemDetail.grading.summary", {
        company: gradedCard.gradingCompany,
        grade: gradedCard.grade,
      });

  return (
    <Stack gap={1}>
      <Inline gap={2}>
        {isVerified ? (
          <Badge tone="success">{t("discovery.routes.itemDetail.grading.cert.verified.badge")}</Badge>
        ) : null}
        <Text size="sm" tone="secondary">
          {certLabel}
        </Text>
      </Inline>
      {isVerified ? (
        <RailReferenceInfo
          analyticsTopic="grading_cert_verification"
          triggerLabel={t("discovery.routes.itemDetail.referenceInfo.gradingCert.trigger")}
          ariaLabel={t("discovery.routes.itemDetail.referenceInfo.gradingCert.aria")}
          title={t("discovery.routes.itemDetail.referenceInfo.gradingCert.title")}
          summary={t("discovery.routes.itemDetail.referenceInfo.gradingCert.summary")}
          lines={[
            t("discovery.routes.itemDetail.referenceInfo.gradingCert.line1"),
            t("discovery.routes.itemDetail.referenceInfo.gradingCert.line2"),
          ]}
        />
      ) : null}
      {lookupUrl ? (
        <Text size="sm" tone="secondary">
          <LinkText href={lookupUrl} target="_blank" rel="noreferrer">
            {t("discovery.routes.itemDetail.grading.cert.lookup")}
          </LinkText>
        </Text>
      ) : null}
    </Stack>
  );
}

export function CheckoutPurchaseIntentSection({
  formId = "buy-box",
  panelVariant = "card",
  showSummary = panelVariant === "card",
  actions,
  actionMode = "all",
  catalogItemId,
  productId,
  selectedListing,
  selectedListingSource = "explicit",
  itemTitle,
  selectedOptions,
  productSelectionDetails = [],
  productSummary,
  visibleListingCount,
  errorMessage,
}: {
  formId?: string;
  panelVariant?: FormPanelVariant;
  showSummary?: boolean;
  actions?: ReactNode;
  actionMode?: "all" | "buy-now" | "add-to-cart";
  catalogItemId: string;
  productId: string | null;
  selectedListing: {
    listing_id: string;
    price_amount: string;
    seller_display_name: string | null;
    shipping_allowance_percentage_bps: number;
    visible_quantity?: number | null;
    quantity_cap?: number | null;
    seller_slug?: string | null;
    seller_average_rating?: string | null;
    seller_review_count?: number;
    /** Account badges mirror (m87 badge facts, m108 reputation). */
    seller_badges?: readonly string[];
    graded_card?: DiscoveryGradedCardDetails | null;
  } | null;
  selectedListingSource?: MarketSelectionSource;
  itemTitle: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSelectionDetails?: readonly ProductSelectionDisplayDetail[];
  productSummary: string | null;
  visibleListingCount: number;
  errorMessage?: string | null;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const addToCartFetcher = useFetcher<ItemDetailActionData>();
  const isProductCartWorkflow = actionMode === "add-to-cart";
  const isListingWorkflow = Boolean(selectedListing && !isProductCartWorkflow);
  const addToCartUsesSelectedListing = Boolean(selectedListing && isListingWorkflow);
  const selectedListingQuantity = selectedListing
    ? parseQuantity(selectedListing.visible_quantity ?? selectedListing.quantity_cap)
    : null;
  const selectedListingPrice = selectedListing
    ? formatMoneyAmount(selectedListing.price_amount)
    : t("discovery.routes.itemDetail.unavailable");
  const selectedListingSeller = selectedListing
    ? (selectedListing.seller_display_name ?? t("discovery.routes.itemDetail.seller"))
    : "No active seller";
  const selectedListingSellerHref = selectedListing?.seller_slug
    ? `/accounts/${selectedListing.seller_slug}#feedback`
    : null;
  const selectedListingAvailability = selectedListing
    ? t("discovery.routes.itemDetail.quantity.available.count", {
        count: selectedListingQuantity,
      })
    : t("discovery.routes.itemDetail.unavailable");
  const addToCartSuccessData = isAddToCartActionData(addToCartFetcher.data) ? addToCartFetcher.data : null;
  const addToCartError = getActionErrorMessage(addToCartFetcher.data);
  const addToCartPending = addToCartFetcher.state !== "idle";
  const showSelectedListingContext = Boolean(selectedListing && isListingWorkflow);
  const selectedListingGradedCard = showSelectedListingContext ? (selectedListing?.graded_card ?? null) : null;
  const selectionHeading =
    selectedListing && showSelectedListingContext
      ? selectedListingSource === "explicit"
        ? t("discovery.features.itemDetail.ui.itemDetailPage.selected.listing")
        : t("discovery.routes.itemDetail.best.available.listing")
      : t("discovery.routes.itemDetail.selected.product");
  const priceLabel = selectedListing
    ? (actionMode === "add-to-cart" && !addToCartUsesSelectedListing) || selectedListingSource === "implicit"
      ? t("discovery.routes.itemDetail.best.available.price")
      : t("discovery.routes.itemDetail.selected.price")
    : t("discovery.routes.itemDetail.market.signal");
  const buyListingReferenceInfo = {
    analyticsTopic: actionMode === "add-to-cart" ? "listing_buy_cart" : "listing_checkout",
    triggerLabel: t("discovery.routes.itemDetail.referenceInfo.buyListing.trigger"),
    ariaLabel: t("discovery.routes.itemDetail.referenceInfo.buyListing.aria"),
    title: t("discovery.routes.itemDetail.referenceInfo.buyListing.title"),
    summary: t("discovery.routes.itemDetail.referenceInfo.buyListing.summary"),
    lines: addToCartUsesSelectedListing
      ? [
          t("discovery.routes.itemDetail.referenceInfo.buyListing.line1"),
          t("discovery.routes.itemDetail.referenceInfo.buyListing.line2"),
          t("discovery.routes.itemDetail.referenceInfo.listingCart.summary"),
          t("discovery.routes.itemDetail.referenceInfo.listingCart.line1"),
          t("discovery.routes.itemDetail.referenceInfo.listingCart.line2"),
        ]
      : [
          t("discovery.routes.itemDetail.referenceInfo.buyListing.line1"),
          t("discovery.routes.itemDetail.referenceInfo.buyListing.line2"),
        ],
  };
  const productCartReferenceInfo = {
    analyticsTopic: "product_buy_cart",
    triggerLabel: t("discovery.routes.itemDetail.referenceInfo.productCart.trigger"),
    ariaLabel: t("discovery.routes.itemDetail.referenceInfo.productCart.aria"),
    title: t("discovery.routes.itemDetail.referenceInfo.productCart.title"),
    summary: t("discovery.routes.itemDetail.referenceInfo.productCart.summary"),
    lines: [
      t("discovery.routes.itemDetail.referenceInfo.productCart.line1"),
      t("discovery.routes.itemDetail.referenceInfo.productCart.line2"),
      t("discovery.routes.itemDetail.referenceInfo.productCart.line3"),
    ],
  };
  const purchaseReferenceInfo = showSelectedListingContext ? buyListingReferenceInfo : productCartReferenceInfo;
  const listingCheckoutWorkflow =
    selectedListing && selectedListingSource === "explicit" ? "selected_listing" : "best_available_listing";
  const listingCheckoutSelection = selectedListing ? selectedListingSource : "none";
  const cartWorkflow = addToCartUsesSelectedListing ? "listing_buy_cart" : "product_buy_cart";
  const cartSelection = addToCartUsesSelectedListing ? selectedListingSource : "none";

  useEffect(() => {
    if (isAddToCartActionData(addToCartFetcher.data)) {
      notifyCartCountChanged(addToCartFetcher.data.quantity);
    }
  }, [addToCartFetcher.data]);

  useEffect(() => {
    if (!errorMessage) {
      return;
    }

    trackItemDetailRailEvent("validation_failed", {
      intent: "buy",
      workflow: actionMode === "add-to-cart" ? cartWorkflow : listingCheckoutWorkflow,
      selection: actionMode === "add-to-cart" ? cartSelection : listingCheckoutSelection,
      outcome: "form_error",
      surface: "action_rail",
    });
  }, [actionMode, cartSelection, cartWorkflow, errorMessage, listingCheckoutSelection, listingCheckoutWorkflow]);

  function trackPurchaseIntentSubmit(event: FormEvent<HTMLFormElement>) {
    const submittedValue = submittedButtonValue(event);
    const isCartSubmit =
      submittedValue === "add-to-cart" || submittedValue === "buy-best-match" || actionMode === "add-to-cart";

    trackItemDetailRailEvent("intent_submit_started", {
      intent: "buy",
      workflow: isCartSubmit ? cartWorkflow : listingCheckoutWorkflow,
      selection: isCartSubmit ? cartSelection : listingCheckoutSelection,
      topic: isCartSubmit ? cartWorkflow : "listing_checkout",
      surface: "action_rail",
    });
  }

  function handleAddToCart() {
    if (!formRef.current) {
      return;
    }

    trackItemDetailRailEvent("intent_submit_started", {
      intent: "buy",
      workflow: cartWorkflow,
      selection: cartSelection,
      topic: cartWorkflow,
      surface: "action_rail",
    });

    const formData = new FormData(formRef.current);
    formData.set("intent", "add-to-cart");
    addToCartFetcher.submit(formData, { method: "post" });
  }
  const buyListingAction = (
    <Button
      type="submit"
      name="intent"
      value="buy-this-listing"
      tone={!isProductCartWorkflow && productId ? "primary" : "secondary"}
      disabled={!productId || !selectedListing}
      block
    >
      {selectedListingSource === "explicit"
        ? t("discovery.routes.itemDetail.buy.now")
        : t("discovery.routes.itemDetail.buy.best.available.listing")}
    </Button>
  );
  const buyBestMatchAction = (
    <Button
      type="submit"
      name="intent"
      value="buy-best-match"
      tone="secondary"
      disabled={!productId || visibleListingCount === 0}
      block
    >
      {t("discovery.routes.itemDetail.buy.best.match")}
    </Button>
  );
  const addToCartAction = (
    <Button
      type="button"
      tone={isProductCartWorkflow && productId ? "primary" : "secondary"}
      disabled={!productId || Boolean(addToCartPending)}
      onClick={() => {
        void handleAddToCart();
      }}
      block
    >
      {addToCartPending
        ? t("discovery.routes.itemDetail.adding.to.cart")
        : addToCartUsesSelectedListing
          ? t("discovery.routes.itemDetail.add.listing.to.cart")
          : t("discovery.routes.itemDetail.add.to.cart")}
    </Button>
  );
  const defaultActions = isProductCartWorkflow ? (
    <>
      {addToCartAction}
      {visibleListingCount > 0 ? buyBestMatchAction : null}
    </>
  ) : (
    <>
      {buyListingAction}
      {addToCartUsesSelectedListing ? addToCartAction : null}
    </>
  );
  const form = (
    <Form spacing="none" id={formId} method="post" ref={formRef} onSubmit={trackPurchaseIntentSubmit}>
      <Stack gap={3}>
        <HiddenInput type="hidden" name="catalogItemId" value={catalogItemId} />
        <HiddenInput type="hidden" name="listingId" value="" />
        <HiddenInput type="hidden" name="lockedListingId" value={selectedListing?.listing_id ?? ""} />
        <HiddenInput
          type="hidden"
          name="sellerPreferenceId"
          value={addToCartUsesSelectedListing ? (selectedListing?.listing_id ?? "") : ""}
        />
        <HiddenInput type="hidden" name="productId" value={productId ?? ""} />
        <HiddenInput type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
        <HiddenInput type="hidden" name="productSummary" value={productSummary ?? ""} />
        <HiddenInput type="hidden" name="priceAmount" value={selectedListing?.price_amount ?? ""} />
        <HiddenInput type="hidden" name="sellerName" value={selectedListing?.seller_display_name ?? ""} />
        <HiddenInput
          type="hidden"
          name="availability"
          value={
            selectedListing
              ? t("discovery.routes.itemDetail.inventory.option.label", {
                  productSummary: productSummary ?? itemTitle,
                  availableQuantity: selectedListingQuantity ?? 0,
                })
              : ""
          }
        />
        {showSummary ? (
          <Stack gap={3}>
            <Stack gap={1}>
              <Text weight="semibold">{selectionHeading}</Text>
            </Stack>
            {showSelectedListingContext ? (
              <Stack gap={1}>
                <Text size="sm" tone="secondary">
                  {priceLabel}
                </Text>
                <Text size="lg" weight="bold">
                  {selectedListingPrice}
                </Text>
                <Inline gap={2}>
                  <AccountReputationSummary
                    accountName={selectedListingSeller}
                    href={selectedListingSellerHref}
                    averageRating={selectedListing?.seller_average_rating}
                    reviewCount={selectedListing?.seller_review_count ?? 0}
                    ratingLabel="Seller account reputation"
                  />
                  {hasTrustedSellerBadge(selectedListing?.seller_badges) ? <TrustedSellerBadge /> : null}
                </Inline>
                <ProductQuantitySummary
                  availability={selectedListingAvailability}
                  productSelectionDetails={productSelectionDetails}
                  productSummary={productSummary}
                  fallback={productId ? itemTitle : t("discovery.routes.itemDetail.choose.options.to.add.this.product")}
                />
                {selectedListingGradedCard ? (
                  <GradingCertificationSummary gradedCard={selectedListingGradedCard} />
                ) : null}
              </Stack>
            ) : (
              <Stack gap={1}>
                <Text size="sm" tone="secondary">
                  {t("discovery.routes.itemDetail.product.criteria")}
                </Text>
                <ProductOptions
                  options={productOptionsFromSelectionDetails(productSelectionDetails)}
                  emptyLabel={productSummary ?? itemTitle}
                />
                <Text size="sm" tone="secondary">
                  {productId
                    ? t("discovery.routes.itemDetail.listing.match.count", {
                        count: visibleListingCount,
                        listingLabel: t(
                          visibleListingCount === 1
                            ? "discovery.routes.itemDetail.listing.matches.singular"
                            : "discovery.routes.itemDetail.listing.matches.plural",
                        ),
                      })
                    : t("discovery.routes.itemDetail.choose.options.to.add.this.product")}
                </Text>
              </Stack>
            )}
            {productId && visibleListingCount === 0 ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.add.to.cart.saves.buyer.intent")}
              </Text>
            ) : null}
            {!productId ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.product.intent.choose.options.guidance")}
              </Text>
            ) : null}
            {productId ? <RailReferenceInfo {...purchaseReferenceInfo} /> : null}
            <Inline gap={2}>
              <OrderProtectionBadge label={t("discovery.routes.itemDetail.buyer.protection.included")} />
              <SecurePaymentCue label={t("discovery.routes.itemDetail.secure.checkout")} />
            </Inline>
          </Stack>
        ) : null}
        {!showSummary && productId ? <RailReferenceInfo {...purchaseReferenceInfo} /> : null}
        {errorMessage ? <Text>{errorMessage}</Text> : null}
        {addToCartSuccessData ? (
          <Banner
            tone="success"
            title={t("discovery.routes.itemDetail.added.to.cart")}
            description={t("discovery.routes.itemDetail.added.to.cart.description", {
              itemTitle: addToCartSuccessData.itemTitle,
            })}
            actions={
              <LinkButton href={addToCartSuccessData.viewCartHref} tone="secondary" size="sm">
                {t("discovery.routes.itemDetail.view.cart")}
              </LinkButton>
            }
          />
        ) : null}
        {addToCartError ? <Banner tone="danger" title={addToCartError} /> : null}
        <NumberInput
          label={t("discovery.routes.itemDetail.quantity")}
          name="quantity"
          min="1"
          defaultValue="1"
          required
        />
        {actions !== undefined ? actions : defaultActions}
      </Stack>
    </Form>
  );

  return (
    <FormPanel variant={panelVariant} glow={visibleListingCount > 0}>
      {form}
    </FormPanel>
  );
}
