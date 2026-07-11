import { t } from "@chase-sets/localization";
import { useEffect, type ReactNode } from "react";
import {
  HiddenInput,
  Form,
  Button,
  CurrencyInput,
  FormPanel,
  type FormPanelVariant,
  LinkButton,
  NumberField,
  ProductOptions,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { trackItemDetailRailEvent } from "../item-detail-rail-analytics";
import {
  formatMoneyAmount,
  productOptionsFromSelectionDetails,
  type ProductSelectionDisplayDetail,
  RailReferenceInfo,
} from "./commerce-primitives";

export function ProductAlertCreationSection({
  formId,
  panelVariant = "card",
  showSummary = panelVariant === "card",
  actions,
  marketSide,
  productId,
  catalogItemId,
  selectedOptions,
  productSelectionDetails = [],
  productSummary,
  errorMessage,
}: {
  formId: string;
  panelVariant?: FormPanelVariant;
  showSummary?: boolean;
  actions?: ReactNode;
  marketSide: "listing" | "offer";
  productId: string | null;
  catalogItemId: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSelectionDetails?: readonly ProductSelectionDisplayDetail[];
  productSummary: string | null;
  errorMessage?: string | null;
}) {
  const isListingAlert = marketSide === "listing";
  const defaultActions = (
    <Button type="submit" disabled={!productId} block>
      {isListingAlert
        ? t("discovery.routes.itemDetail.set.listing.alert")
        : t("discovery.routes.itemDetail.set.offer.alert")}
    </Button>
  );
  const watchWorkflow = isListingAlert ? "watch_listings" : "watch_offers";
  const watchTopic = isListingAlert ? "listing_alert" : "offer_alert";

  useEffect(() => {
    if (!errorMessage) {
      return;
    }

    trackItemDetailRailEvent("validation_failed", {
      intent: "watch",
      workflow: watchWorkflow,
      topic: watchTopic,
      outcome: "form_error",
      surface: "action_rail",
    });
  }, [errorMessage, watchTopic, watchWorkflow]);

  return (
    <FormPanel variant={panelVariant}>
      <Form
        spacing="none"
        id={formId}
        method="post"
        onSubmit={() => {
          trackItemDetailRailEvent("intent_submit_started", {
            intent: "watch",
            workflow: watchWorkflow,
            topic: watchTopic,
            surface: "action_rail",
          });
        }}
      >
        <Stack gap={3}>
          <HiddenInput type="hidden" name="intent" value="create-product-alert" />
          <HiddenInput type="hidden" name="marketSide" value={marketSide} />
          <HiddenInput type="hidden" name="catalogItemId" value={catalogItemId} />
          <HiddenInput type="hidden" name="productId" value={productId ?? ""} />
          <HiddenInput type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
          <HiddenInput type="hidden" name="productSummary" value={productSummary ?? ""} />
          {showSummary ? (
            <Stack gap={3}>
              <Stack gap={1}>
                <Text weight="semibold">
                  {isListingAlert
                    ? t("discovery.routes.itemDetail.watch.listings")
                    : t("discovery.routes.itemDetail.watch.offers")}
                </Text>
                <RailReferenceInfo
                  analyticsTopic={isListingAlert ? "listing_alert" : "offer_alert"}
                  triggerLabel={t(
                    isListingAlert
                      ? "discovery.routes.itemDetail.referenceInfo.watchListings.trigger"
                      : "discovery.routes.itemDetail.referenceInfo.watchOffers.trigger",
                  )}
                  ariaLabel={t(
                    isListingAlert
                      ? "discovery.routes.itemDetail.referenceInfo.watchListings.aria"
                      : "discovery.routes.itemDetail.referenceInfo.watchOffers.aria",
                  )}
                  title={t(
                    isListingAlert
                      ? "discovery.routes.itemDetail.referenceInfo.watchListings.title"
                      : "discovery.routes.itemDetail.referenceInfo.watchOffers.title",
                  )}
                  summary={t(
                    isListingAlert
                      ? "discovery.routes.itemDetail.referenceInfo.watchListings.summary"
                      : "discovery.routes.itemDetail.referenceInfo.watchOffers.summary",
                  )}
                  lines={[
                    t(
                      isListingAlert
                        ? "discovery.routes.itemDetail.referenceInfo.watchListings.line1"
                        : "discovery.routes.itemDetail.referenceInfo.watchOffers.line1",
                    ),
                    t(
                      isListingAlert
                        ? "discovery.routes.itemDetail.referenceInfo.watchListings.line2"
                        : "discovery.routes.itemDetail.referenceInfo.watchOffers.line2",
                    ),
                  ]}
                />
              </Stack>
              <Stack gap={1}>
                <Text size="sm" tone="secondary">
                  {t("discovery.routes.itemDetail.product.criteria")}
                </Text>
                <ProductOptions
                  options={productOptionsFromSelectionDetails(productSelectionDetails)}
                  emptyLabel={productSummary ?? "Selected product"}
                />
              </Stack>
            </Stack>
          ) : null}
          <CurrencyInput
            label={isListingAlert ? "Maximum listing price" : "Minimum offer price"}
            name="thresholdAmount"
            currencyCode="USD"
            placeholder={isListingAlert ? "25.00" : "15.00"}
            min="0"
            step="0.01"
          />
          {errorMessage ? <Text>{errorMessage}</Text> : null}
          {actions !== undefined ? actions : defaultActions}
        </Stack>
      </Form>
    </FormPanel>
  );
}

export function MarketplaceOfferSubmissionSection({
  formId = "make-offer",
  panelVariant = "card",
  showSummary = panelVariant === "card",
  actions,
  catalogItemId,
  productId,
  itemTitle,
  selectedOptions,
  productSelectionDetails = [],
  productSummary,
  lowestListing,
  errorMessage,
}: {
  formId?: string;
  panelVariant?: FormPanelVariant;
  showSummary?: boolean;
  actions?: ReactNode;
  catalogItemId: string;
  productId: string | null;
  itemTitle: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSelectionDetails?: readonly ProductSelectionDisplayDetail[];
  productSummary: string | null;
  lowestListing?: { price_amount: string } | null;
  errorMessage?: string | null;
}) {
  const defaultActions = (
    <Button type="submit" disabled={!productId} block>
      {t("discovery.routes.itemDetail.make.offer.action")}
    </Button>
  );
  useEffect(() => {
    if (!errorMessage) {
      return;
    }

    trackItemDetailRailEvent("validation_failed", {
      intent: "buy",
      workflow: "make_offer",
      topic: "make_offer",
      outcome: "form_error",
      surface: "action_rail",
    });
  }, [errorMessage]);

  const form = (
    <Form
      spacing="none"
      id={formId}
      method="post"
      onSubmit={() => {
        trackItemDetailRailEvent("intent_submit_started", {
          intent: "buy",
          workflow: "make_offer",
          topic: "make_offer",
          surface: "action_rail",
        });
      }}
    >
      <Stack gap={3}>
        <HiddenInput type="hidden" name="intent" value="submit-offer" />
        <HiddenInput type="hidden" name="catalogItemId" value={catalogItemId} />
        <HiddenInput type="hidden" name="productId" value={productId ?? ""} />
        <HiddenInput type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
        <HiddenInput type="hidden" name="productSummary" value={productSummary ?? ""} />
        {showSummary ? (
          <Stack gap={3}>
            <Stack gap={1}>
              <Text weight="semibold">{t("discovery.routes.itemDetail.make.an.offer")}</Text>
              <RailReferenceInfo
                analyticsTopic="make_offer"
                triggerLabel={t("discovery.routes.itemDetail.referenceInfo.makeOffer.trigger")}
                ariaLabel={t("discovery.routes.itemDetail.referenceInfo.makeOffer.aria")}
                title={t("discovery.routes.itemDetail.referenceInfo.makeOffer.title")}
                summary={t("discovery.routes.itemDetail.referenceInfo.makeOffer.summary")}
                lines={[
                  t("discovery.routes.itemDetail.referenceInfo.makeOffer.line1"),
                  t("discovery.routes.itemDetail.referenceInfo.makeOffer.line2"),
                ]}
              />
            </Stack>
            <Stack gap={1}>
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.selected.product")}
              </Text>
              <ProductOptions
                options={productOptionsFromSelectionDetails(productSelectionDetails)}
                emptyLabel={productSummary ?? itemTitle}
              />
              {productId && lowestListing ? (
                <Text size="sm" tone="secondary">
                  {t("discovery.routes.itemDetail.current.lowest.listing.summary", {
                    price: formatMoneyAmount(lowestListing.price_amount),
                  })}
                </Text>
              ) : !productId ? (
                <Text size="sm" tone="secondary">
                  {t("discovery.routes.itemDetail.choose.options.to.make.an.offer")}
                </Text>
              ) : null}
            </Stack>
          </Stack>
        ) : null}
        {errorMessage ? <Text>{errorMessage}</Text> : null}
        <CurrencyInput
          label={t("discovery.routes.itemDetail.offer.price")}
          name="priceAmount"
          currencyCode="USD"
          placeholder="24.99"
          min="0"
          step="0.01"
          required
        />
        <NumberField label={t("discovery.routes.itemDetail.quantity")} name="quantityRequested" min={1} required />
        {actions !== undefined ? actions : defaultActions}
      </Stack>
    </Form>
  );

  return <FormPanel variant={panelVariant}>{form}</FormPanel>;
}

export function MarketplaceOfferRegistrationSection({
  panelVariant = "card",
  showSummary = panelVariant === "card",
  isAuthenticated,
  productId,
  itemTitle,
  productSelectionDetails = [],
  productSummary,
  visibleListingCount,
  registerHref,
}: {
  panelVariant?: FormPanelVariant;
  showSummary?: boolean;
  isAuthenticated: boolean;
  productId: string | null;
  itemTitle: string;
  productSelectionDetails?: readonly ProductSelectionDisplayDetail[];
  productSummary: string | null;
  visibleListingCount: number;
  registerHref: string;
}) {
  const offerRegistrationGate = isAuthenticated ? "buyer_account_setup" : "buyer_registration";

  useEffect(() => {
    trackItemDetailRailEvent("registration_gate_shown", {
      intent: "buy",
      workflow: "make_offer",
      gate: offerRegistrationGate,
      viewer: isAuthenticated ? "signed_in" : "guest",
      surface: "action_rail",
    });
  }, [isAuthenticated, offerRegistrationGate]);

  return (
    <FormPanel variant={panelVariant}>
      <Stack gap={3}>
        {showSummary ? (
          <Stack gap={2}>
            <Text weight="semibold">
              {isAuthenticated ? "Make offer unavailable" : t("discovery.routes.itemDetail.make.offer.after.sign.in")}
            </Text>
            <ProductOptions
              options={productOptionsFromSelectionDetails(productSelectionDetails)}
              emptyLabel={productSummary ?? itemTitle}
              variant={productSelectionDetails.length === 0 ? "chips" : "inline"}
            />
            <Text size="sm" tone="secondary">
              {productId && isAuthenticated
                ? t("discovery.routes.itemDetail.product.wide.offers.available", {
                    count: visibleListingCount,
                    listingLabel: t(
                      visibleListingCount === 1
                        ? "discovery.routes.itemDetail.listing.matches.singular"
                        : "discovery.routes.itemDetail.listing.matches.plural",
                    ),
                  })
                : productId
                  ? t("discovery.routes.itemDetail.offer.registration.context", {
                      count: visibleListingCount,
                      listingLabel: t(
                        visibleListingCount === 1
                          ? "discovery.routes.itemDetail.listing.singular"
                          : "discovery.routes.itemDetail.listing.plural",
                      ),
                    })
                  : t("discovery.routes.itemDetail.choose.options.before.offer.registration")}
            </Text>
            {!isAuthenticated ? (
              <RailReferenceInfo
                analyticsTopic="make_offer"
                triggerLabel={t("discovery.routes.itemDetail.referenceInfo.makeOffer.trigger")}
                ariaLabel={t("discovery.routes.itemDetail.referenceInfo.makeOffer.aria")}
                title={t("discovery.routes.itemDetail.referenceInfo.makeOffer.title")}
                summary={t("discovery.routes.itemDetail.referenceInfo.makeOffer.summary")}
                lines={[
                  t("discovery.routes.itemDetail.referenceInfo.makeOffer.line1"),
                  t("discovery.routes.itemDetail.referenceInfo.makeOffer.line2"),
                ]}
              />
            ) : null}
          </Stack>
        ) : null}
        {isAuthenticated ? (
          <Text size="sm">{t("discovery.routes.itemDetail.account.cannot.submit.product.wide.offers.yet")}</Text>
        ) : null}
        <LinkButton
          href={registerHref}
          tone="secondary"
          block
          onClick={() => {
            trackItemDetailRailEvent("registration_started", {
              intent: "buy",
              workflow: "make_offer",
              gate: offerRegistrationGate,
              viewer: isAuthenticated ? "signed_in" : "guest",
              surface: "action_rail",
            });
          }}
        >
          {isAuthenticated
            ? "Complete account setup to make offer"
            : t("discovery.routes.itemDetail.sign.in.or.register.to.make.offer")}
        </LinkButton>
      </Stack>
    </FormPanel>
  );
}
