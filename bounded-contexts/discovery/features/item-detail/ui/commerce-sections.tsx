import { t } from "@chase-sets/localization";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";
import {
  HiddenInput,
  Form,
  AccordionOptionTrigger,
  AccountReputationSummary,
  Badge,
  Banner,
  Button,
  CurrencyInput,
  FormPanel,
  type FormPanelVariant,
  Inline,
  InlineTextGroup,
  KeyValueList,
  LinkButton,
  NativeSelect,
  NumberInput,
  PanelSectionAccordion,
  ProductOptions,
  ReferenceInfoDialog,
  type ReferenceInfoSection,
  ReferenceInfoTrigger,
  SegmentedControl,
  OrderProtectionBadge,
  Stack,
  SecurePaymentCue,
  Text,
  TextInput,
  type IconName,
  type AccordionSectionEdge,
} from "@chase-sets/design-system";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type {
  DiscoveryMarketListing,
  DiscoverySellerInventoryItem,
  DiscoveryAccountOfferMatch,
} from "../../../support/client-support/contracts";

export type CommerceAccordionEdge = AccordionSectionEdge;

type MarketplaceListingTermsPreview = Readonly<{
  account_type: string;
  basis_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  schedule_id?: string | null;
  agreement_id?: string | null;
  resolved_at: string;
  fee_quote_fingerprint?: string;
  source_kind?: "public-standard-seller-terms";
  source_label?: string;
  schedule_label?: string;
  source_updated_at?: string;
}>;

type ProductSelectionDisplayDetail = Readonly<{
  label: ReactNode;
  value: ReactNode;
}>;

type MarketSelectionSource = "explicit" | "implicit";

function productOptionsFromSelectionDetails(selections: readonly ProductSelectionDisplayDetail[]) {
  return selections.map((selection) => ({
    dimensionLabel: selection.label,
    optionLabel: selection.value,
  }));
}

function ProductQuantitySummary({
  availability,
  productSelectionDetails,
  productSummary,
  fallback,
}: {
  availability: ReactNode;
  productSelectionDetails: readonly ProductSelectionDisplayDetail[];
  productSummary: ReactNode;
  fallback: ReactNode;
}) {
  return (
    <InlineTextGroup gap={3} align="end">
      <ProductOptions
        options={productOptionsFromSelectionDetails(productSelectionDetails)}
        emptyLabel={productSummary ?? fallback}
        variant="compact"
        size="sm"
        truncate
      />
      <Text element="span" size="sm" tone="secondary" weight="medium">
        {availability}
      </Text>
    </InlineTextGroup>
  );
}

export type AddToCartActionData = Readonly<{
  status: "added-to-cart";
  itemTitle: string;
  quantity: number;
}>;

type ItemDetailActionData = AddToCartActionData | Readonly<{ error: string }> | null;

function isAddToCartActionData(value: unknown): value is AddToCartActionData {
  return Boolean(
    value &&
    typeof value === "object" &&
    "status" in value &&
    (value as { status?: unknown }).status === "added-to-cart",
  );
}

export function getActionErrorMessage(value: unknown) {
  return value && typeof value === "object" && "error" in value ? String(value.error ?? "") : null;
}

function notifyCartCountChanged(quantity: number) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent("chase-sets:cart-count-changed", {
      detail: { countDelta: quantity },
    }),
  );
}

export function canUseAccountCheckoutCart(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  return Boolean(actor);
}

function formatAllowancePercentage(bps: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(bps / 100)}%`;
}

function parseMoneyAmount(value: string | null | undefined): number | null {
  const amount = Number.parseFloat(String(value ?? ""));

  return Number.isFinite(amount) ? amount : null;
}

function formatMoneyAmount(value: string | number | null | undefined) {
  const amount = typeof value === "number" ? value : parseMoneyAmount(value);

  return amount === null
    ? t("discovery.routes.itemDetail.unavailable")
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(amount);
}

function multiplyMoneyAmount(value: string, quantity: number) {
  const amount = parseMoneyAmount(value);

  return amount === null ? null : amount * quantity;
}

function parseQuantity(value: number | null | undefined): number {
  const quantity = Number(value);

  return Number.isFinite(quantity) ? quantity : 0;
}

function formatTermsSource(terms: MarketplaceListingTermsPreview) {
  if (terms.source_label) {
    return terms.source_label;
  }

  if (terms.agreement_id) {
    return t("discovery.routes.itemDetail.seller.specific.terms");
  }

  if (terms.schedule_id) {
    return t("discovery.routes.itemDetail.standard.seller.terms");
  }

  return t("discovery.routes.itemDetail.standard.terms");
}

function ReferenceInfoText({ lines }: { lines: readonly ReactNode[] }) {
  return (
    <Stack gap={2}>
      {lines.map((line, index) => (
        <Text key={index} size="sm" tone="secondary">
          {line}
        </Text>
      ))}
    </Stack>
  );
}

function RailReferenceInfo({
  triggerLabel,
  ariaLabel,
  title,
  description,
  summary,
  sections,
  lines,
}: {
  triggerLabel: string;
  ariaLabel: string;
  title: string;
  description?: string;
  summary?: ReactNode;
  sections?: readonly ReferenceInfoSection[];
  lines?: readonly ReactNode[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <ReferenceInfoTrigger tone="subtle" aria-label={ariaLabel} onClick={() => setOpen(true)}>
        {triggerLabel}
      </ReferenceInfoTrigger>
      <ReferenceInfoDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        closeLabel={t("discovery.features.itemDetail.ui.itemDetailPage.close.reference.detail")}
        summary={summary}
        sections={sections ? [...sections] : undefined}
      >
        {lines?.length ? <ReferenceInfoText lines={lines} /> : null}
      </ReferenceInfoDialog>
    </>
  );
}

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
        ? t("discovery.routes.itemDetail.set.alert")
        : t("discovery.routes.itemDetail.create.product.alert")}
    </Button>
  );

  return (
    <FormPanel variant={panelVariant}>
      <Form spacing="none" id={formId} method="post">
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
                  {isListingAlert ? t("discovery.routes.itemDetail.alert.criteria") : "Watch for offers"}
                </Text>
                <RailReferenceInfo
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
  const form = (
    <Form spacing="none" id={formId} method="post">
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
          placeholder="24.99"
          min="0"
          step="0.01"
          required
        />
        <NumberInput label={t("discovery.routes.itemDetail.quantity")} name="quantityRequested" min="1" required />
        {actions !== undefined ? actions : defaultActions}
      </Stack>
    </Form>
  );

  return <FormPanel variant={panelVariant}>{form}</FormPanel>;
}

function MarketplaceOfferRegistrationSection({
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
        <LinkButton href={registerHref} tone="secondary" block>
          {isAuthenticated
            ? "Complete account setup to make offer"
            : t("discovery.routes.itemDetail.sign.in.or.register.to.make.offer")}
        </LinkButton>
      </Stack>
    </FormPanel>
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
  const addToCartUsesSelectedListing = Boolean(
    selectedListing && selectedListingSource === "explicit" && isListingWorkflow,
  );
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
  useEffect(() => {
    if (isAddToCartActionData(addToCartFetcher.data)) {
      notifyCartCountChanged(addToCartFetcher.data.quantity);
    }
  }, [addToCartFetcher.data]);

  function handleAddToCart() {
    if (!formRef.current) {
      return;
    }

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
      value="buy-now"
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
    <Form spacing="none" id={formId} method="post" ref={formRef}>
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
                </Inline>
                <ProductQuantitySummary
                  availability={selectedListingAvailability}
                  productSelectionDetails={productSelectionDetails}
                  productSummary={productSummary}
                  fallback={productId ? itemTitle : t("discovery.routes.itemDetail.choose.options.to.add.this.product")}
                />
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
              <LinkButton href="/account/cart" tone="secondary" size="sm">
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

export function MarketplaceOfferMatchSection({
  formId = "sell-box",
  panelVariant = "card",
  showSummary = panelVariant === "card",
  actions,
  actionMode = "all",
  selectedOffer,
  selectedOfferSource = "explicit",
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
  const quoteTime = acceptanceTerms ? new Date(acceptanceTerms.resolved_at).toLocaleString() : null;
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
  const sellNowAction = (
    <Button type="submit" name="intent" value="sell-now" disabled={!selectedOfferCanFulfill} block>
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
    <Form spacing="none" id={formId} method="post">
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
                            percentage: formatAllowancePercentage(acceptanceTerms.shipping_allowance_percentage_bps),
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
                                percentage: formatAllowancePercentage(
                                  acceptanceTerms.shipping_allowance_percentage_bps,
                                ),
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
  return (
    <FormPanel variant={panelVariant} glow={Boolean(productId)}>
      <Form spacing="none" id={formId} method="post">
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
  const selectedOfferQuoteTime = selectedOfferQuote ? new Date(selectedOfferQuote.resolved_at).toLocaleString() : null;
  const selectedOfferBuyerName = selectedOffer?.buyer_display_name?.trim();
  const selectedOfferBuyer = selectedOfferBuyerName || t("discovery.features.itemDetail.ui.itemDetailPage.buyer");
  const selectedOfferBuyerHref = selectedOffer?.buyer_slug ? `/accounts/${selectedOffer.buyer_slug}#feedback` : null;
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
                          percentage: formatAllowancePercentage(selectedOfferQuote.shipping_allowance_percentage_bps),
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
        <LinkButton href={registerHref} leadingIcon="plus" block>
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
        <LinkButton href={registerHref} leadingIcon="plus" block>
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

export function ListingStockShipFromSetupSection({
  formId,
  errorMessage,
}: {
  formId: string;
  errorMessage?: string | null;
}) {
  return (
    <FormPanel variant="card">
      <Form spacing="none" id={formId} method="post">
        <Stack gap={3}>
          <HiddenInput type="hidden" name="intent" value="create-listing-stock-location" />
          <Stack gap={1}>
            <Text weight="semibold">{t("discovery.routes.itemDetail.ship.from.setup")}</Text>
            <Text size="sm" tone="secondary">
              {t("discovery.routes.itemDetail.ship.from.setup.description")}
            </Text>
          </Stack>
          <TextInput label={t("discovery.routes.itemDetail.ship.from.name")} name="shipFromName" required />
          <TextInput label={t("discovery.routes.itemDetail.ship.from.line1")} name="shipFromLine1" required />
          <Inline>
            <TextInput label={t("discovery.routes.itemDetail.ship.from.city")} name="shipFromCity" required />
            <TextInput label={t("discovery.routes.itemDetail.ship.from.state")} name="shipFromState" required />
          </Inline>
          <Inline>
            <TextInput
              label={t("discovery.routes.itemDetail.ship.from.postal.code")}
              name="shipFromPostalCode"
              required
            />
            <TextInput
              label={t("discovery.routes.itemDetail.ship.from.country")}
              name="shipFromCountry"
              defaultValue="US"
              required
            />
          </Inline>
          {errorMessage ? <Text>{errorMessage}</Text> : null}
          <Button type="submit" block>
            {t("discovery.routes.itemDetail.save.ship.from.setup")}
          </Button>
        </Stack>
      </Form>
    </FormPanel>
  );
}

export function MarketplaceListingSubmissionSection({
  formId = "list-box",
  panelVariant = "card",
  showSummary = panelVariant === "card",
  actions,
  productId,
  selectedOptions,
  productSummary,
  productSelectionDetails = [],
  bestListing,
  ownListing,
  hasListingStockLocation,
  allowDraftWithoutShipFromSetup = false,
  errorMessage,
}: {
  formId?: string;
  panelVariant?: FormPanelVariant;
  showSummary?: boolean;
  actions?: ReactNode;
  productId: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  productSelectionDetails?: readonly ProductSelectionDisplayDetail[];
  bestListing: {
    listing_id: string;
    inventory_item_id: string;
    product_id: string;
    price_amount: string;
    quantity_cap: number;
    status: string;
  } | null;
  ownListing: DiscoveryMarketListing | null;
  hasListingStockLocation: boolean;
  allowDraftWithoutShipFromSetup?: boolean;
  errorMessage?: string | null;
}) {
  const listing = ownListing ?? null;
  const listPrice = listing?.price_amount ?? bestListing?.price_amount ?? "";
  const defaultQuantity = listing?.quantity_cap ?? 1;
  const requiresShipFromSetup = !listing && !hasListingStockLocation && !allowDraftWithoutShipFromSetup;
  const canUseListAction = Boolean(productId && !requiresShipFromSetup);
  const defaultActions = listing ? (
    <LinkButton href={`/account/listings/${listing.listing_id}`} block>
      {t("discovery.routes.itemDetail.manage.listing")}
    </LinkButton>
  ) : (
    <Button type="submit" name="intent" value="list-at-price" disabled={!canUseListAction} block>
      {t("discovery.routes.itemDetail.list.for.sale")}
    </Button>
  );

  const form = (
    <Form spacing="none" id={formId} method="post">
      <Stack gap={3}>
        <HiddenInput type="hidden" name="productId" value={productId ?? ""} />
        <HiddenInput type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
        <HiddenInput type="hidden" name="productSummary" value={productSummary ?? ""} />
        <HiddenInput type="hidden" name="listingId" value={listing?.listing_id ?? ""} />
        {showSummary ? (
          <Stack gap={1}>
            <Text weight="semibold">
              {listing
                ? t("discovery.routes.itemDetail.update.your.listing")
                : t("discovery.routes.itemDetail.sell.on.chase.sets")}
            </Text>
            {productSelectionDetails.length > 0 ? (
              <ProductOptions
                options={productOptionsFromSelectionDetails(productSelectionDetails)}
                emptyLabel={
                  productSummary ?? t("discovery.routes.itemDetail.choose.options.to.list.matching.inventory")
                }
              />
            ) : (
              <Text size="sm" tone="secondary">
                {productSummary
                  ? t("discovery.routes.itemDetail.selling.product", { productSummary })
                  : t("discovery.routes.itemDetail.choose.options.to.list.matching.inventory")}
              </Text>
            )}
            {listing ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.your.listing.summary", {
                  status: listing.status,
                  price: listing.price_amount,
                })}
              </Text>
            ) : bestListing ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.current.best.listing.summary", {
                  price: bestListing.price_amount,
                })}
              </Text>
            ) : null}
            <RailReferenceInfo
              triggerLabel={t("discovery.routes.itemDetail.referenceInfo.createListing.trigger")}
              ariaLabel={t("discovery.routes.itemDetail.referenceInfo.createListing.aria")}
              title={t("discovery.routes.itemDetail.referenceInfo.createListing.title")}
              summary={t("discovery.routes.itemDetail.referenceInfo.createListing.summary")}
              lines={[
                t("discovery.routes.itemDetail.referenceInfo.createListing.line1"),
                t("discovery.routes.itemDetail.referenceInfo.createListing.line2"),
              ]}
            />
          </Stack>
        ) : null}
        {listing ? <HiddenInput type="hidden" name="inventoryItemId" value={listing.inventory_item_id} /> : null}
        {listing ? (
          <>
            <HiddenInput type="hidden" name="priceAmount" value={listPrice} />
            <HiddenInput type="hidden" name="quantityCap" value={String(defaultQuantity)} />
          </>
        ) : (
          <>
            <CurrencyInput
              label={t("discovery.routes.itemDetail.listing.price")}
              name="priceAmount"
              defaultValue={listPrice}
              placeholder="24.99"
              min="0"
              step="0.01"
              required
            />
            <NumberInput
              label={t("discovery.routes.itemDetail.quantity")}
              name="quantityCap"
              min="1"
              defaultValue={String(defaultQuantity)}
              required
            />
          </>
        )}
        {!listing && requiresShipFromSetup ? (
          <Text size="sm" tone="secondary">
            {t("discovery.routes.itemDetail.ship.from.setup.required")}
          </Text>
        ) : null}
        {errorMessage ? <Text>{errorMessage}</Text> : null}
        {actions !== undefined ? actions : defaultActions}
      </Stack>
    </Form>
  );

  return (
    <Stack gap={3}>
      <FormPanel variant={panelVariant} glow={Boolean(listing)}>
        {form}
      </FormPanel>
      {requiresShipFromSetup ? (
        <ListingStockShipFromSetupSection formId={`${formId}-ship-from-setup`} errorMessage={errorMessage} />
      ) : null}
    </Stack>
  );
}

type BuyAction = "buy-now" | "add-to-cart" | "make-offer";
type SellAction = "selected-offer" | "add-product-to-sell-list" | "list-for-sale";
type WatchAction = "watch-listings" | "watch-offers";

type CommerceActionOption<TAction extends string> = Readonly<{
  value: TAction;
  label: string;
  description: string;
  icon: IconName;
  disabled?: boolean;
}>;

function ItemDetailActionCard<TAction extends string>({
  title,
  description,
  productSummary,
  productSelectionDetails,
  options,
  selectedAction,
  onSelectedActionChange,
  children,
  panelVariant = "card",
  accordionEdge,
  glow = false,
  showProductSummary = true,
  footer,
}: {
  title: string;
  description: string;
  productSummary: string | null;
  productSelectionDetails: readonly ProductSelectionDisplayDetail[];
  options: readonly CommerceActionOption<TAction>[];
  selectedAction: TAction | "";
  onSelectedActionChange: (action: TAction | "") => void;
  children: ReactNode;
  panelVariant?: FormPanelVariant;
  accordionEdge?: CommerceAccordionEdge;
  glow?: boolean;
  showProductSummary?: boolean;
  footer?: ReactNode;
}) {
  return (
    <FormPanel variant={panelVariant} glow={glow}>
      <Stack gap={3}>
        <Stack gap={1}>
          <Text weight="semibold">{title}</Text>
          <Text size="sm" tone="secondary">
            {description}
          </Text>
          {showProductSummary ? (
            <ProductOptions
              options={productOptionsFromSelectionDetails(productSelectionDetails)}
              emptyLabel={productSummary ?? t("discovery.routes.itemDetail.choose.options.to.select.product")}
              variant={productSelectionDetails.length === 0 ? "chips" : "inline"}
            />
          ) : null}
        </Stack>
        {footer}
        <PanelSectionAccordion
          type="single"
          edge={accordionEdge ?? (panelVariant === "plain" ? "compact" : "card")}
          value={selectedAction}
          onValueChange={(value) => {
            if (typeof value === "string") {
              const selectedOption = options.find((option) => option.value === value);

              if (selectedOption?.disabled) {
                return;
              }

              onSelectedActionChange(value as TAction | "");
            }
          }}
          items={options.map((option) => ({
            value: option.value,
            disabled: option.disabled,
            trigger: (
              <AccordionOptionTrigger
                icon={option.icon}
                title={option.label}
                description={option.description}
                active={selectedAction === option.value}
                disabled={option.disabled}
              />
            ),
            content: selectedAction === option.value ? children : null,
          }))}
        />
      </Stack>
    </FormPanel>
  );
}

export function BuyActionCard({
  formIdPrefix,
  panelVariant = "card",
  accordionEdge,
  productId,
  productSummary,
  productSelectionDetails,
  visibleListingCount,
  hasSelectedListing,
  selectedListingSource = "implicit",
  renderBuyNow,
  renderAddToCart,
  renderOffer,
}: {
  formIdPrefix: string;
  panelVariant?: FormPanelVariant;
  accordionEdge?: CommerceAccordionEdge;
  productId: string | null;
  productSummary: string | null;
  productSelectionDetails: readonly ProductSelectionDisplayDetail[];
  visibleListingCount: number;
  hasSelectedListing?: boolean;
  selectedListingSource?: MarketSelectionSource;
  renderBuyNow: (formId: string) => ReactNode;
  renderAddToCart: (formId: string) => ReactNode;
  renderOffer: (formId: string) => ReactNode;
}) {
  const defaultAction: BuyAction = productId && visibleListingCount > 0 ? "buy-now" : "make-offer";
  const [selectedAction, setSelectedAction] = useState<BuyAction | "">(defaultAction);

  useEffect(() => {
    setSelectedAction(defaultAction);
  }, [defaultAction]);

  const listingWorkflowLabel =
    hasSelectedListing && selectedListingSource === "explicit"
      ? t("discovery.features.itemDetail.ui.itemDetailPage.selected.listing")
      : t("discovery.routes.itemDetail.best.available.listing");
  const listingWorkflowDescription =
    hasSelectedListing && selectedListingSource === "explicit"
      ? t("discovery.routes.itemDetail.selected.listing.workflow.helper")
      : t("discovery.routes.itemDetail.best.available.listing.workflow.helper");
  const options = [
    {
      value: "buy-now",
      label: listingWorkflowLabel,
      description: listingWorkflowDescription,
      icon: "creditCard",
      disabled: !productId || visibleListingCount === 0,
    },
    {
      value: "add-to-cart",
      label: t("discovery.routes.itemDetail.selected.product"),
      description: t("discovery.routes.itemDetail.add.to.cart.workflow.helper"),
      icon: "cart",
      disabled: !productId,
    },
    {
      value: "make-offer",
      label: t("discovery.routes.itemDetail.make.an.offer"),
      description: t("discovery.routes.itemDetail.make.offer.action.description"),
      icon: "tag",
      disabled: !productId,
    },
  ] satisfies readonly CommerceActionOption<BuyAction>[];
  const selectedContent =
    selectedAction === "buy-now"
      ? renderBuyNow(`${formIdPrefix}-buy-now`)
      : selectedAction === "add-to-cart"
        ? renderAddToCart(`${formIdPrefix}-add-to-cart`)
        : selectedAction === "make-offer"
          ? renderOffer(`${formIdPrefix}-make-offer`)
          : null;

  return (
    <ItemDetailActionCard
      title={t("discovery.routes.itemDetail.buy.card.title")}
      description={t("discovery.routes.itemDetail.buy.card.description")}
      productSummary={productSummary}
      productSelectionDetails={productSelectionDetails}
      options={options}
      selectedAction={selectedAction}
      onSelectedActionChange={setSelectedAction}
      panelVariant={panelVariant}
      accordionEdge={accordionEdge}
      glow={visibleListingCount > 0}
      showProductSummary={false}
    >
      {selectedContent}
    </ItemDetailActionCard>
  );
}

export function SellActionCard({
  formIdPrefix,
  panelVariant = "card",
  accordionEdge,
  productId,
  productSummary,
  productSelectionDetails,
  hasMatchingOffer,
  canSelectListingAction = true,
  canSelectProductSellListAction = canSelectListingAction,
  selectedOfferSource = "implicit",
  renderSelectedOffer,
  renderAddProductToSellList,
  renderListing,
}: {
  formIdPrefix: string;
  panelVariant?: FormPanelVariant;
  accordionEdge?: CommerceAccordionEdge;
  productId: string | null;
  productSummary: string | null;
  productSelectionDetails: readonly ProductSelectionDisplayDetail[];
  hasMatchingOffer: boolean;
  canSelectListingAction?: boolean;
  canSelectProductSellListAction?: boolean;
  selectedOfferSource?: MarketSelectionSource;
  renderSelectedOffer: (formId: string) => ReactNode;
  renderAddProductToSellList: (formId: string) => ReactNode;
  renderListing: (formId: string) => ReactNode;
}) {
  const defaultAction: SellAction | "" = hasMatchingOffer
    ? "selected-offer"
    : canSelectProductSellListAction
      ? "add-product-to-sell-list"
      : canSelectListingAction
        ? "list-for-sale"
        : "";
  const [selectedAction, setSelectedAction] = useState<SellAction | "">(defaultAction);

  useEffect(() => {
    setSelectedAction(defaultAction);
  }, [defaultAction]);

  const selectedOfferWorkflowLabel =
    selectedOfferSource === "explicit"
      ? t("discovery.routes.itemDetail.selected.offer.heading")
      : t("discovery.routes.itemDetail.best.offer.heading");
  const options = [
    {
      value: "selected-offer",
      label: selectedOfferWorkflowLabel,
      description: t("discovery.routes.itemDetail.selected.offer.workflow.helper"),
      icon: "dollar",
      disabled: !productId || !hasMatchingOffer,
    },
    {
      value: "add-product-to-sell-list",
      label: t("discovery.routes.itemDetail.selected.product"),
      description: t("discovery.routes.itemDetail.add.product.to.sell.list.action.description"),
      icon: "spark",
      disabled: !productId || !canSelectProductSellListAction,
    },
    {
      value: "list-for-sale",
      label: t("discovery.routes.itemDetail.sell.on.chase.sets"),
      description: t("discovery.routes.itemDetail.list.for.sale.action.description"),
      icon: "store",
      disabled: !productId || !canSelectListingAction,
    },
  ] satisfies readonly CommerceActionOption<SellAction>[];
  const selectedContent =
    selectedAction === "selected-offer"
      ? renderSelectedOffer(`${formIdPrefix}-selected-offer`)
      : selectedAction === "add-product-to-sell-list"
        ? renderAddProductToSellList(`${formIdPrefix}-product-sell-list`)
        : selectedAction === "list-for-sale"
          ? renderListing(`${formIdPrefix}-list-for-sale`)
          : null;

  return (
    <ItemDetailActionCard
      title={t("discovery.routes.itemDetail.sell.card.title")}
      description={t("discovery.routes.itemDetail.sell.card.description")}
      productSummary={productSummary}
      productSelectionDetails={productSelectionDetails}
      options={options}
      selectedAction={selectedAction}
      onSelectedActionChange={setSelectedAction}
      panelVariant={panelVariant}
      accordionEdge={accordionEdge}
      glow={hasMatchingOffer}
      showProductSummary={false}
    >
      {selectedContent}
    </ItemDetailActionCard>
  );
}

export function WatchActionCard({
  formIdPrefix,
  panelVariant = "card",
  accordionEdge,
  productId,
  productSummary,
  productSelectionDetails,
  renderListingAlert,
  renderOfferAlert,
}: {
  formIdPrefix: string;
  panelVariant?: FormPanelVariant;
  accordionEdge?: CommerceAccordionEdge;
  productId: string | null;
  productSummary: string | null;
  productSelectionDetails: readonly ProductSelectionDisplayDetail[];
  renderListingAlert: (formId: string) => ReactNode;
  renderOfferAlert: (formId: string) => ReactNode;
}) {
  const defaultAction: WatchAction = "watch-listings";
  const [selectedAction, setSelectedAction] = useState<WatchAction | "">(defaultAction);

  useEffect(() => {
    setSelectedAction(defaultAction);
  }, [defaultAction]);

  const options = [
    {
      value: "watch-listings",
      label: t("discovery.routes.itemDetail.watch.listings"),
      description: t("discovery.routes.itemDetail.watch.listings.description"),
      icon: "bell",
      disabled: !productId,
    },
    {
      value: "watch-offers",
      label: t("discovery.routes.itemDetail.watch.offers"),
      description: t("discovery.routes.itemDetail.watch.offers.description"),
      icon: "eye",
      disabled: !productId,
    },
  ] satisfies readonly CommerceActionOption<WatchAction>[];
  const selectedContent =
    selectedAction === "watch-offers"
      ? renderOfferAlert(`${formIdPrefix}-offer-alert`)
      : selectedAction === "watch-listings"
        ? renderListingAlert(`${formIdPrefix}-listing-alert`)
        : null;

  return (
    <ItemDetailActionCard
      title={t("discovery.routes.itemDetail.watch")}
      description={t("discovery.routes.itemDetail.watch.card.description")}
      productSummary={productSummary}
      productSelectionDetails={productSelectionDetails}
      options={options}
      selectedAction={selectedAction}
      onSelectedActionChange={setSelectedAction}
      panelVariant={panelVariant}
      accordionEdge={accordionEdge}
      showProductSummary={false}
    >
      {selectedContent}
    </ItemDetailActionCard>
  );
}

export function ItemCommercePanel({
  buyer,
  seller,
  watch,
  showSellerTab,
}: {
  buyer: ReactNode;
  seller: ReactNode;
  watch?: ReactNode;
  showSellerTab: boolean;
}) {
  const [mode, setMode] = useState<"buy" | "sell" | "watch">("buy");

  return (
    <Stack gap={3}>
      {showSellerTab ? (
        <SegmentedControl
          items={[
            { value: "buy", label: t("discovery.routes.itemDetail.buy") },
            { value: "sell", label: t("discovery.routes.itemDetail.sell") },
            { value: "watch", label: t("discovery.routes.itemDetail.watch") },
          ]}
          value={mode}
          onValueChange={(value) => setMode(value === "sell" ? "sell" : value === "watch" ? "watch" : "buy")}
        />
      ) : null}
      {mode === "watch" && watch ? watch : mode === "sell" && showSellerTab ? seller : buyer}
    </Stack>
  );
}
