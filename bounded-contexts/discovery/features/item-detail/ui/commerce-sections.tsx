import { t } from "@chase-sets/localization";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";
import {
  AccordionOptionTrigger,
  AccountReputationSummary,
  Badge,
  Banner,
  Button,
  CurrencyInput,
  FormPanel,
  type FormPanelVariant,
  Inline,
  KeyValueList,
  LinkButton,
  NativeSelect,
  NumberInput,
  PanelSectionAccordion,
  ProductOptions,
  SegmentedControl,
  OrderProtectionBadge,
  Stack,
  SecurePaymentCue,
  Text,
  TextInput,
  type IconName,
  type AccordionSectionEdge,
  productOptionsFromSummary,
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
  schedule_id: string | null;
  agreement_id: string | null;
  resolved_at: string;
  fee_quote_fingerprint: string;
}>;

const PUBLIC_SELLER_QUOTE_MARKETPLACE_FEE_BPS = 700;
const PUBLIC_SELLER_QUOTE_MARKETPLACE_FEE_FIXED_AMOUNT = 0.05;
const PUBLIC_SELLER_QUOTE_SHIPPING_ALLOWANCE_BPS = 500;

type ProductSelectionDisplayDetail = Readonly<{
  label: ReactNode;
  value: ReactNode;
}>;

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
    <div className="grid min-w-0 gap-x-3 gap-y-0.5 min-[360px]:grid-cols-[minmax(0,1fr)_auto] min-[360px]:items-baseline">
      <ProductOptions
        options={productOptionsFromSelectionDetails(productSelectionDetails)}
        emptyLabel={productSummary ?? fallback}
        variant="compact"
        className="min-w-0 text-sm font-semibold leading-5"
      />
      <span className="text-sm font-medium leading-5 text-secondary">{availability}</span>
    </div>
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

function roundMoneyAmount(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function toMoneyAmount(value: number) {
  return roundMoneyAmount(value).toFixed(2);
}

function createSellerRegistrationQuote(priceAmount: string): MarketplaceListingTermsPreview | null {
  const basisAmount = parseMoneyAmount(priceAmount);

  if (basisAmount === null) {
    return null;
  }

  const marketplaceFeeUnitAmount = roundMoneyAmount(
    (basisAmount * PUBLIC_SELLER_QUOTE_MARKETPLACE_FEE_BPS) / 10000 + PUBLIC_SELLER_QUOTE_MARKETPLACE_FEE_FIXED_AMOUNT,
  );
  const sellerNetUnitAmount = Math.max(0, roundMoneyAmount(basisAmount - marketplaceFeeUnitAmount));

  return {
    account_type: "personal",
    basis_amount: toMoneyAmount(basisAmount),
    marketplace_sales_fee_unit_amount: toMoneyAmount(marketplaceFeeUnitAmount),
    seller_net_unit_amount: toMoneyAmount(sellerNetUnitAmount),
    shipping_allowance_percentage_bps: PUBLIC_SELLER_QUOTE_SHIPPING_ALLOWANCE_BPS,
    schedule_id: "public_seller_quote",
    agreement_id: null,
    resolved_at: new Date().toISOString(),
    fee_quote_fingerprint: [
      toMoneyAmount(basisAmount),
      toMoneyAmount(marketplaceFeeUnitAmount),
      toMoneyAmount(sellerNetUnitAmount),
      PUBLIC_SELLER_QUOTE_SHIPPING_ALLOWANCE_BPS,
      "public_seller_quote",
    ].join("|"),
  };
}

function formatTermsSource(terms: MarketplaceListingTermsPreview) {
  if (terms.agreement_id) {
    return t("discovery.routes.itemDetail.seller.specific.terms");
  }

  if (terms.schedule_id) {
    return t("discovery.routes.itemDetail.standard.seller.terms");
  }

  return t("discovery.routes.itemDetail.standard.terms");
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
      <form id={formId} method="post">
        <Stack gap={3}>
          <input type="hidden" name="intent" value="create-product-alert" />
          <input type="hidden" name="marketSide" value={marketSide} />
          <input type="hidden" name="catalogItemId" value={catalogItemId} />
          <input type="hidden" name="productId" value={productId ?? ""} />
          <input type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
          <input type="hidden" name="productSummary" value={productSummary ?? ""} />
          {showSummary ? (
            <Stack gap={3}>
              <Stack gap={1}>
                <Text weight="semibold">
                  {isListingAlert ? t("discovery.routes.itemDetail.alert.criteria") : "Watch for offers"}
                </Text>
                <Text size="sm" tone="secondary">
                  {isListingAlert
                    ? t("discovery.routes.itemDetail.alert.matching.supply.at.target.price")
                    : "Get a web notification when matching offer demand appears at your price."}
                </Text>
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
          {actions !== undefined ? actions : defaultActions}
        </Stack>
      </form>
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
  visibleListingCount,
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
  visibleListingCount: number;
  errorMessage?: string | null;
}) {
  const defaultActions = (
    <Button type="submit" disabled={!productId} block>
      {t("discovery.routes.itemDetail.submit.offer")}
    </Button>
  );
  const form = (
    <form id={formId} method="post">
      <Stack gap={3}>
        <input type="hidden" name="intent" value="submit-offer" />
        <input type="hidden" name="catalogItemId" value={catalogItemId} />
        <input type="hidden" name="productId" value={productId ?? ""} />
        <input type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
        <input type="hidden" name="productSummary" value={productSummary ?? ""} />
        {showSummary ? (
          <Stack gap={3}>
            <Stack gap={1}>
              <Text weight="semibold">{t("discovery.routes.itemDetail.offer.details")}</Text>
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.submit.product.wide.demand")}
              </Text>
            </Stack>
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
                  : t("discovery.routes.itemDetail.choose.options.to.make.an.offer")}
              </Text>
            </Stack>
            <Text size="sm" tone="secondary">
              {productId
                ? t("discovery.routes.itemDetail.offer.applies.to.matching.product.criteria")
                : t("discovery.routes.itemDetail.choose.options.to.make.an.offer")}
            </Text>
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
        <NumberInput
          label={t("discovery.routes.itemDetail.quantity.requested")}
          name="quantityRequested"
          min="1"
          required
        />
        {actions !== undefined ? actions : defaultActions}
      </Stack>
    </form>
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
          </Stack>
        ) : null}
        <Text size="sm" tone="secondary">
          {isAuthenticated
            ? "This account cannot submit product-wide offers yet."
            : t("discovery.routes.itemDetail.offer.requires.account")}
        </Text>
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
  itemTitle: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSelectionDetails?: readonly ProductSelectionDisplayDetail[];
  productSummary: string | null;
  visibleListingCount: number;
  errorMessage?: string | null;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const addToCartFetcher = useFetcher<ItemDetailActionData>();
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
  function getProductIntentGuidance() {
    if (actionMode === "buy-now") {
      return t("discovery.routes.itemDetail.checkout.immediately.with.best.matching.live.listing");
    }

    if (actionMode === "add-to-cart") {
      return t("discovery.routes.itemDetail.add.to.cart.workflow.helper");
    }

    if (!productId) {
      return t("discovery.routes.itemDetail.product.intent.choose.options.guidance");
    }

    return visibleListingCount === 0
      ? t("discovery.routes.itemDetail.product.intent.no.supply.guidance")
      : t("discovery.routes.itemDetail.product.intent.buy.guidance");
  }

  const productIntentGuidance = getProductIntentGuidance();
  const priceLabel = selectedListing
    ? actionMode === "add-to-cart"
      ? t("discovery.routes.itemDetail.best.available.price")
      : t("discovery.routes.itemDetail.selected.price")
    : t("discovery.routes.itemDetail.market.signal");
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
  const buyNowAction = (
    <Button
      type="submit"
      name="intent"
      value={actionMode === "buy-now" && selectedListing ? "buy-this-listing" : "buy-now"}
      tone={actionMode === "buy-now" && productId ? "primary" : "secondary"}
      disabled={!productId || (actionMode === "buy-now" && !selectedListing)}
      block
    >
      {t("discovery.routes.itemDetail.buy.now")}
    </Button>
  );
  const lockedListingAction = (
    <Button
      type="submit"
      name="intent"
      value="buy-this-listing"
      tone="secondary"
      disabled={!productId || !selectedListing}
      block
    >
      {t("discovery.routes.itemDetail.buy.locked.to.this.seller")}
    </Button>
  );
  const addToCartAction = (
    <Button
      type="button"
      tone={actionMode === "add-to-cart" && productId ? "primary" : "secondary"}
      disabled={!productId || Boolean(addToCartPending)}
      onClick={() => {
        void handleAddToCart();
      }}
      block
    >
      {addToCartPending
        ? t("discovery.routes.itemDetail.adding.to.cart")
        : t("discovery.routes.itemDetail.add.to.cart")}
    </Button>
  );
  const defaultActions =
    actionMode === "buy-now" ? (
      buyNowAction
    ) : actionMode === "add-to-cart" ? (
      addToCartAction
    ) : (
      <>
        {buyNowAction}
        {lockedListingAction}
        {addToCartAction}
      </>
    );
  const form = (
    <form id={formId} method="post" ref={formRef}>
      <Stack gap={3}>
        <input type="hidden" name="catalogItemId" value={catalogItemId} />
        <input type="hidden" name="listingId" value="" />
        <input type="hidden" name="lockedListingId" value={selectedListing?.listing_id ?? ""} />
        <input type="hidden" name="productId" value={productId ?? ""} />
        <input type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
        <input type="hidden" name="productSummary" value={productSummary ?? ""} />
        <input type="hidden" name="priceAmount" value={selectedListing?.price_amount ?? ""} />
        <input type="hidden" name="sellerName" value={selectedListing?.seller_display_name ?? ""} />
        <input
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
              <Text weight="semibold">{t("discovery.routes.itemDetail.your.selection")}</Text>
            </Stack>
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
            {productId && visibleListingCount === 0 ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.add.to.cart.saves.buyer.intent")}
              </Text>
            ) : null}
            {actionMode === "all" ? (
              <Text size="sm" tone="secondary">
                {productIntentGuidance}
              </Text>
            ) : null}
            <Inline gap={2}>
              <OrderProtectionBadge label={t("discovery.routes.itemDetail.buyer.protection.included")} />
              <SecurePaymentCue label={t("discovery.routes.itemDetail.secure.checkout")} />
            </Inline>
          </Stack>
        ) : null}
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
    </form>
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
    seller_available_quantity: number;
    can_fulfill: boolean;
    in_sell_list: boolean;
    product_summary?: string | null;
    buyer_slug?: string | null;
    buyer_average_rating?: string | null;
    buyer_review_count?: number;
    acceptance_terms?: MarketplaceListingTermsPreview | null;
  } | null;
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
  const selectedOfferBuyer = selectedOffer?.buyer_display_name ?? selectedOffer?.buyer_account_id ?? "Buyer account";
  const selectedOfferBuyerHref = selectedOffer?.buyer_slug ? `/accounts/${selectedOffer.buyer_slug}#feedback` : null;
  const sellNowAction = (
    <Button type="submit" name="intent" value="sell-now" disabled={!selectedOffer?.can_fulfill} block>
      {t("discovery.routes.itemDetail.sell.now")}
    </Button>
  );
  const addToSellListAction = (
    <Button
      type="submit"
      name="intent"
      value="add-to-sell-list"
      tone={actionMode === "add-to-sell-list" && selectedOffer?.can_fulfill ? "primary" : "secondary"}
      disabled={!selectedOffer?.can_fulfill || selectedOffer.in_sell_list}
      block
    >
      {selectedOffer?.in_sell_list
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
    <form id={formId} method="post">
      <Stack gap={3}>
        <input type="hidden" name="offerId" value={selectedOffer?.offer_id ?? ""} />
        <input
          type="hidden"
          name="feeQuoteFingerprint"
          value={selectedOffer?.acceptance_terms?.fee_quote_fingerprint ?? ""}
        />
        {showSummary ? (
          <Stack gap={1}>
            <Text weight="semibold">{t("discovery.routes.itemDetail.accept.offer")}</Text>
            {selectedOffer ? (
              <>
                <Stack gap={1}>
                  <Inline gap={2}>
                    <Text weight="semibold">
                      {t("discovery.routes.itemDetail.offer.total", {
                        amount: formatMoneyAmount(acceptedValue),
                      })}
                    </Text>
                    <Badge tone={selectedOffer.can_fulfill ? "success" : "warning"}>
                      {selectedOffer.can_fulfill
                        ? t("discovery.routes.itemDetail.can.fulfill")
                        : t("discovery.routes.itemDetail.needs.supply")}
                    </Badge>
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
                          value: t("discovery.routes.itemDetail.requested.available.summary", {
                            requested: selectedOffer.quantity_requested,
                            available: selectedOffer.seller_available_quantity,
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
                    <Text size="sm" tone="secondary">
                      {t("discovery.routes.itemDetail.offer.terms.summary", {
                        source: formatTermsSource(acceptanceTerms),
                        time: quoteTime ?? t("discovery.routes.itemDetail.just.now"),
                      })}
                    </Text>
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
    </form>
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
      <form id={formId} method="post">
        <Stack gap={3}>
          <input type="hidden" name="intent" value="add-product-to-sell-list" />
          <input type="hidden" name="catalogItemId" value={catalogItemId} />
          <input type="hidden" name="productId" value={productId ?? ""} />
          <input type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
          <input type="hidden" name="productSummary" value={productSummary ?? ""} />
          {showSummary ? (
            <Stack gap={2}>
              <Text weight="semibold">{t("discovery.routes.itemDetail.add.product.to.sell.list")}</Text>
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.add.product.to.sell.list.summary")}
              </Text>
              <ProductOptions
                options={productOptionsFromSelectionDetails(productSelectionDetails)}
                emptyLabel={productSummary ?? itemTitle}
                variant={productSelectionDetails.length === 0 ? "chips" : "inline"}
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
      </form>
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
    price_amount: string;
    quantity_requested: number;
  } | null;
  matchingOfferCount?: number;
  registerHref: string;
}) {
  const selectedOfferQuote = selectedOffer ? createSellerRegistrationQuote(selectedOffer.price_amount) : null;
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
  const offerRegistrationPanel = selectedOffer ? (
    <FormPanel variant={panelVariant} glow>
      <Stack gap={3}>
        {showSummary ? (
          <Stack gap={1}>
            <Text weight="semibold">{t("discovery.routes.itemDetail.accept.offer.after.registration")}</Text>
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
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.offer.from.buyer", {
                  buyer: selectedOffer.buyer_display_name ?? selectedOffer.buyer_account_id,
                })}
              </Text>
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
                        value: t("discovery.routes.itemDetail.seller.payout.after.fee", {
                          payout: formatMoneyAmount(sellerNetTotal),
                          fee: formatMoneyAmount(marketplaceFeeTotal),
                        }),
                      },
                      {
                        key: t("discovery.routes.itemDetail.shipping.allowance"),
                        value: t("discovery.routes.itemDetail.shipping.allowance.amount", {
                          amount: formatMoneyAmount(shippingAllowanceAmount),
                          percentage: formatAllowancePercentage(selectedOfferQuote.shipping_allowance_percentage_bps),
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
            {selectedOfferQuote ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.registration.quote.summary", {
                  source: formatTermsSource(selectedOfferQuote),
                })}
              </Text>
            ) : null}
            <Text size="sm" tone="secondary">
              {t("discovery.routes.itemDetail.register.to.confirm.inventory.and.see.payout")}
            </Text>
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
            <Text size="sm" tone="secondary">
              {selectedOffer
                ? t("discovery.routes.itemDetail.list.instead.of.accepting.offer")
                : t("discovery.routes.itemDetail.register.to.list.inventory.buy.cards")}
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
            {!selectedOffer && productSummary ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.start.with")}
                <ProductOptions options={productOptionsFromSummary(productSummary)} variant="compact" />
              </Text>
            ) : !selectedOffer ? (
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
      <form id={formId} method="post">
        <Stack gap={3}>
          <input type="hidden" name="intent" value="create-listing-stock-location" />
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
      </form>
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
  errorMessage?: string | null;
}) {
  const listing = ownListing ?? null;
  const listPrice = listing?.price_amount ?? bestListing?.price_amount ?? "";
  const defaultQuantity = listing?.quantity_cap ?? 1;
  const requiresShipFromSetup = !listing && !hasListingStockLocation;
  const canUseListAction = Boolean(productId && listPrice && !requiresShipFromSetup);
  const defaultActions = listing ? (
    <LinkButton href={`/account/listings/${listing.listing_id}`} block>
      {t("discovery.routes.itemDetail.manage.listing")}
    </LinkButton>
  ) : (
    <Button type="submit" name="intent" value="list-at-price" disabled={!canUseListAction} block>
      {t("discovery.routes.itemDetail.list.at.price")}
    </Button>
  );

  const form = (
    <form id={formId} method="post">
      <Stack gap={3}>
        <input type="hidden" name="productId" value={productId ?? ""} />
        <input type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
        <input type="hidden" name="listingId" value={listing?.listing_id ?? ""} />
        <input type="hidden" name="priceAmount" value={listPrice} />
        <input type="hidden" name="quantityCap" value={String(defaultQuantity)} />
        {showSummary ? (
          <Stack gap={1}>
            <Text weight="semibold">
              {listing
                ? t("discovery.routes.itemDetail.update.your.listing")
                : t("discovery.routes.itemDetail.list.at.price.2")}
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
          </Stack>
        ) : null}
        {listing ? <input type="hidden" name="inventoryItemId" value={listing.inventory_item_id} /> : null}
        {!listing ? (
          <Text size="sm" tone="secondary">
            {requiresShipFromSetup
              ? t("discovery.routes.itemDetail.ship.from.setup.required")
              : t("discovery.routes.itemDetail.listing.stock.created.automatically")}
          </Text>
        ) : null}
        {errorMessage ? <Text>{errorMessage}</Text> : null}
        {actions !== undefined ? actions : defaultActions}
      </Stack>
    </form>
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
type SellAction = "sell-now" | "add-to-sell-list" | "add-product-to-sell-list" | "list-for-sale";
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
  renderBuyNow: (formId: string) => ReactNode;
  renderAddToCart: (formId: string) => ReactNode;
  renderOffer: (formId: string) => ReactNode;
}) {
  const defaultAction: BuyAction = productId && visibleListingCount > 0 ? "buy-now" : "make-offer";
  const [selectedAction, setSelectedAction] = useState<BuyAction | "">(defaultAction);

  useEffect(() => {
    setSelectedAction(defaultAction);
  }, [defaultAction]);

  const options = [
    {
      value: "buy-now",
      label: t("discovery.routes.itemDetail.buy.now"),
      description: t("discovery.routes.itemDetail.buy.now.workflow.helper"),
      icon: "creditCard",
      disabled: !productId || visibleListingCount === 0,
    },
    {
      value: "add-to-cart",
      label: t("discovery.routes.itemDetail.add.to.cart"),
      description: t("discovery.routes.itemDetail.add.to.cart.workflow.helper"),
      icon: "cart",
      disabled: !productId,
    },
    {
      value: "make-offer",
      label: t("discovery.routes.itemDetail.make.offer.action"),
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
      title={t("discovery.routes.itemDetail.choose.action")}
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
  canUseSellerFeatures,
  canUseListingFeatures = canUseSellerFeatures,
  canUseProductSellListFeatures = canUseListingFeatures,
  renderSellNow,
  renderAddToSellList,
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
  canUseSellerFeatures: boolean;
  canUseListingFeatures?: boolean;
  canUseProductSellListFeatures?: boolean;
  renderSellNow: (formId: string) => ReactNode;
  renderAddToSellList: (formId: string) => ReactNode;
  renderAddProductToSellList: (formId: string) => ReactNode;
  renderListing: (formId: string) => ReactNode;
}) {
  const defaultAction: SellAction | "" = hasMatchingOffer
    ? "sell-now"
    : canUseProductSellListFeatures
      ? "add-product-to-sell-list"
      : canUseListingFeatures
        ? "list-for-sale"
        : "";
  const [selectedAction, setSelectedAction] = useState<SellAction | "">(defaultAction);

  useEffect(() => {
    setSelectedAction(defaultAction);
  }, [defaultAction]);

  const options = [
    {
      value: "sell-now",
      label: t("discovery.routes.itemDetail.sell.now"),
      description: t("discovery.routes.itemDetail.sell.now.action.description"),
      icon: "dollar",
      disabled: !productId || !hasMatchingOffer,
    },
    {
      value: "add-to-sell-list",
      label: t("discovery.routes.itemDetail.add.to.sell.list"),
      description: t("discovery.routes.itemDetail.add.to.sell.list.action.description"),
      icon: "cart",
      disabled: !productId || !hasMatchingOffer,
    },
    {
      value: "add-product-to-sell-list",
      label: t("discovery.routes.itemDetail.add.product.to.sell.list"),
      description: t("discovery.routes.itemDetail.add.product.to.sell.list.action.description"),
      icon: "spark",
      disabled: !productId || !canUseProductSellListFeatures,
    },
    {
      value: "list-for-sale",
      label: t("discovery.routes.itemDetail.list.for.sale"),
      description: t("discovery.routes.itemDetail.list.for.sale.action.description"),
      icon: "store",
      disabled: !productId || !canUseListingFeatures,
    },
  ] satisfies readonly CommerceActionOption<SellAction>[];
  const selectedContent =
    selectedAction === "sell-now"
      ? renderSellNow(`${formIdPrefix}-sell-now`)
      : selectedAction === "add-to-sell-list"
        ? renderAddToSellList(`${formIdPrefix}-sell-list`)
        : selectedAction === "add-product-to-sell-list"
          ? renderAddProductToSellList(`${formIdPrefix}-product-sell-list`)
          : selectedAction === "list-for-sale"
            ? renderListing(`${formIdPrefix}-list-for-sale`)
            : null;

  return (
    <ItemDetailActionCard
      title={t("discovery.routes.itemDetail.sell.card.title")}
      description={
        canUseSellerFeatures
          ? t("discovery.routes.itemDetail.sell.card.description")
          : t("discovery.routes.itemDetail.sell.card.registration.description")
      }
      productSummary={productSummary}
      productSelectionDetails={productSelectionDetails}
      options={options}
      selectedAction={selectedAction}
      onSelectedActionChange={setSelectedAction}
      panelVariant={panelVariant}
      accordionEdge={accordionEdge}
      glow={hasMatchingOffer}
      showProductSummary={false}
      footer={<Badge tone="accent">{t("discovery.routes.itemDetail.same.buyer.shipping.allowance")}</Badge>}
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
