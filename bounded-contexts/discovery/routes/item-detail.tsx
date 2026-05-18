import { t } from "@chase-sets/localization";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { redirect, useActionData, useFetcher, useLoaderData } from "react-router";
import {
  Accordion,
  AccordionOptionTrigger,
  Badge,
  Banner,
  BuyerProtectionBadge,
  Button,
  CurrencyInput,
  FormPanel,
  type FormPanelVariant,
  Inline,
  KeyValueList,
  LinkButton,
  NativeSelect,
  NumberInput,
  ProductSelectionSummary,
  SegmentedControl,
  Stack,
  SecurePaymentCue,
  Text,
  TextInput,
  type IconName,
} from "@chase-sets/design-system";
import {
  requireActorFromAuthApi,
  resolveActorFromAuthApi,
} from "@chase-sets/platform-runtime/auth";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import {
  createDiscoveryRequestApiClient,
  DiscoveryApiError,
} from "../support/request-support/api-client";
import { applyDiscoveryItemPatch } from "../support/client-support/realtime-market";
import { discoveryRealtimeRouteTopics } from "../support/realtime-support/topics";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoverySellerInventoryItem,
  DiscoveryAccountOfferMatch,
} from "../support/client-support/contracts";
import { discoveryAssetUrls, imageVariantSrcSet } from "../support/client-support/assets";
import { selectDiscoveryProductAssetUrl } from "../support/client-support/product-assets";
import {
  createMarketplaceRequestApiClient,
  type MarketplaceListingInventoryItemOption,
  type MarketplaceListingTermsPreview,
} from "@chase-sets/marketplace/server";
import { createInventoryRequestApiClient } from "@chase-sets/inventory/server";
import {
  appendAnonymousCartCookie,
  createCheckoutRequestApiClient,
  ensureAnonymousCartId,
} from "@chase-sets/checkout/server";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";

const MARKETPLACE_DESCRIPTION =
  t("discovery.routes.itemDetail.browse.the.chase.sets.marketplace.with");
const LISTING_STOCK_LOCATION_NAME = "Listing stock";
const LISTING_STOCK_LOCATION_DESCRIPTION =
  "Auto-managed stock backing standard marketplace listings.";
const LISTING_STOCK_SHIP_FROM_CODE = "LISTING-STOCK";

const EMPTY_ITEM_DETAIL_RESULT = {
  item: null,
  accountOfferMatches: [],
  sellerInventoryItems: [],
  sellerAccountId: null,
  hasListingStockLocation: false,
  viewerAccountId: null,
  initialMarketIntent: "buy" as const,
  initialSelectedOptions: [],
  hasInitialSelectedOptionFilters: false,
  showSellerTab: true,
  canUseSellerFeatures: false,
  canSubmitOffers: false,
  registerToSellHref: "/register",
  notFound: false,
  error: null,
  canonicalUrl: null,
} as const;

type DiscoveryOfferMatchWithTerms = DiscoveryAccountOfferMatch & Readonly<{
  acceptance_terms: MarketplaceListingTermsPreview | null;
}>;

const PUBLIC_SELLER_QUOTE_MARKETPLACE_FEE_BPS = 700;
const PUBLIC_SELLER_QUOTE_MARKETPLACE_FEE_FIXED_AMOUNT = 0.05;
const PUBLIC_SELLER_QUOTE_SHIPPING_ALLOWANCE_BPS = 500;

type ProductSelectionDisplayDetail = Readonly<{
  label: ReactNode;
  value: ReactNode;
}>;

function ProductCriteriaText({
  selections,
  summary,
  fallback,
}: {
  selections: readonly ProductSelectionDisplayDetail[];
  summary: ReactNode;
  fallback: ReactNode;
}) {
  if (selections.length === 0) {
    return <>{summary ?? fallback}</>;
  }

  return (
    <>
      {selections.map((selection, index) => (
        <span key={index}>
          {index > 0 ? " · " : null}
          {selection.value}
        </span>
      ))}
    </>
  );
}

type AddToCartActionData = Readonly<{
  status: "added-to-cart";
  itemTitle: string;
  quantity: number;
}>;

type ItemDetailActionData =
  | AddToCartActionData
  | Readonly<{ error: string }>
  | null;

function isAddToCartActionData(value: unknown): value is AddToCartActionData {
  return Boolean(
    value &&
      typeof value === "object" &&
      "status" in value &&
      (value as { status?: unknown }).status === "added-to-cart",
  );
}

function getActionErrorMessage(value: unknown) {
  return value && typeof value === "object" && "error" in value
    ? String(value.error ?? "")
    : null;
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

function canUseAccountCheckoutCart(
  actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>,
) {
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
  const amount =
    typeof value === "number" ? value : parseMoneyAmount(value);

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

function createSellerRegistrationQuote(
  priceAmount: string,
): MarketplaceListingTermsPreview | null {
  const basisAmount = parseMoneyAmount(priceAmount);

  if (basisAmount === null) {
    return null;
  }

  const marketplaceFeeUnitAmount = roundMoneyAmount(
    (basisAmount * PUBLIC_SELLER_QUOTE_MARKETPLACE_FEE_BPS) / 10000 +
      PUBLIC_SELLER_QUOTE_MARKETPLACE_FEE_FIXED_AMOUNT,
  );
  const sellerNetUnitAmount = Math.max(
    0,
    roundMoneyAmount(basisAmount - marketplaceFeeUnitAmount),
  );

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

function selectItemImageUrl(
  item: Partial<Pick<DiscoveryItemDetail, "image_urls" | "product_asset_sets" | "image_fallback">>,
  role: "thumbnail" | "catalog-detail" = "catalog-detail",
): string | null {
  const productAssetSets = Array.isArray(item.product_asset_sets)
    ? item.product_asset_sets
    : [];
  const imageUrls = Array.isArray(item.image_urls) ? item.image_urls : [];

  return selectDiscoveryProductAssetUrl(productAssetSets, role) ??
    imageUrls[0] ??
    (item.image_fallback?.usage === "permanent" ? item.image_fallback.url : null) ??
    null;
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

function buildRegisterToSellHref(request: Request) {
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;

  return `/register?returnTo=${encodeURIComponent(returnTo)}`;
}

export function readInitialSelectedOptions(searchParams: URLSearchParams) {
  const selectedByDimension = new Map<string, Set<string>>();

  for (const [key, value] of searchParams.entries()) {
    if (!key.startsWith("dimension.") || !value.trim()) {
      continue;
    }

    const dimensionId = key.slice("dimension.".length).trim();
    const optionId = value.trim();

    if (!dimensionId || !optionId) {
      continue;
    }

    selectedByDimension.set(
      dimensionId,
      new Set([...(selectedByDimension.get(dimensionId) ?? []), optionId]),
    );
  }

  return [...selectedByDimension.entries()]
    .filter(([, optionIds]) => optionIds.size === 1)
    .map(([dimensionId, optionIds]) => ({
      dimensionId,
      optionId: [...optionIds][0],
    }));
}

function hasInitialSelectedOptionFilters(searchParams: URLSearchParams) {
  return [...searchParams.entries()].some(([key, value]) =>
    key.startsWith("dimension.") && value.trim().length > 0,
  );
}

function toSellerInventoryItem(
  inventoryItem: MarketplaceListingInventoryItemOption,
): DiscoverySellerInventoryItem {
  return {
    item_id: inventoryItem.item_id,
    catalog_catalog_item_id: inventoryItem.catalog_catalog_item_id,
    product_id: inventoryItem.product_id,
    item_title: inventoryItem.item_title,
    item_subtitle: inventoryItem.item_subtitle,
    selected_options: inventoryItem.selected_options,
    product_summary: inventoryItem.product_summary,
    storage_location_name: inventoryItem.storage_location_name,
    ship_from_code: inventoryItem.ship_from_code,
    available_quantity: inventoryItem.available_quantity,
  };
}

function parseSelectedOptions(value: FormDataEntryValue | null) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));

    return Array.isArray(parsed)
      ? parsed
          .filter(
            (selection): selection is { dimensionId: string; optionId: string } =>
              Boolean(
                selection &&
                typeof selection === "object" &&
                "dimensionId" in selection &&
                "optionId" in selection,
              ),
          )
          .map((selection) => ({
            dimensionId: String(selection.dimensionId ?? ""),
            optionId: String(selection.optionId ?? ""),
          }))
      : [];
  } catch {
    return [];
  }
}

function shipFromAddressFromForm(formData: FormData) {
  const address = {
    name: String(formData.get("shipFromName") ?? "").trim(),
    line1: String(formData.get("shipFromLine1") ?? "").trim(),
    city: String(formData.get("shipFromCity") ?? "").trim(),
    state: String(formData.get("shipFromState") ?? "").trim(),
    postalCode: String(formData.get("shipFromPostalCode") ?? "").trim(),
    country: String(formData.get("shipFromCountry") ?? "US").trim() || "US",
  };

  if (
    !address.name &&
    !address.line1 &&
    !address.city &&
    !address.state &&
    !address.postalCode
  ) {
    return null;
  }

  return address;
}

function ProductAlertCreationSection({
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
          <input
            type="hidden"
            name="selectedOptions"
            value={JSON.stringify(selectedOptions)}
          />
          <input type="hidden" name="productSummary" value={productSummary ?? ""} />
          {showSummary ? (
            <Stack gap={3}>
              <Stack gap={1}>
                <Text weight="semibold">
                  {isListingAlert
                    ? t("discovery.routes.itemDetail.alert.criteria")
                    : "Watch for offers"}
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
                <Text size="sm">
                  <ProductCriteriaText
                    selections={productSelectionDetails}
                    summary={productSummary}
                    fallback={t("discovery.routes.itemDetail.selected.product")}
                  />
                </Text>
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

function MarketplaceOfferSubmissionSection({
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
      {t("discovery.routes.itemDetail.submit.offer")}</Button>
  );
  const form = (
    <form id={formId} method="post">
      <Stack gap={3}>
        <input type="hidden" name="intent" value="submit-offer" />
        <input type="hidden" name="catalogItemId" value={catalogItemId} />
        <input type="hidden" name="productId" value={productId ?? ""} />
        <input
          type="hidden"
          name="selectedOptions"
          value={JSON.stringify(selectedOptions)}
        />
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
              <Text size="sm">
                <ProductCriteriaText
                  selections={productSelectionDetails}
                  summary={productSummary}
                  fallback={itemTitle}
                />
              </Text>
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
        <NumberInput label={t("discovery.routes.itemDetail.quantity.requested")} name="quantityRequested" min="1" required />
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
              {isAuthenticated
                ? "Make offer unavailable"
                : t("discovery.routes.itemDetail.make.offer.after.sign.in")}
            </Text>
            <ProductSelectionSummary
              selections={productSelectionDetails}
              summary={productSummary ?? itemTitle}
              summaryAsChip={productSelectionDetails.length === 0}
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
  const selectedListingSeller =
    selectedListing
      ? selectedListing.seller_display_name ?? t("discovery.routes.itemDetail.seller")
      : "No active seller";
  const selectedListingAvailability = selectedListing
    ? t("discovery.routes.itemDetail.quantity.available.count", {
        count: selectedListingQuantity,
      })
    : t("discovery.routes.itemDetail.unavailable");
  const addToCartSuccessData = isAddToCartActionData(addToCartFetcher.data)
    ? addToCartFetcher.data
    : null;
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
  const defaultActions = actionMode === "buy-now" ? (
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
        <input
          type="hidden"
          name="selectedOptions"
          value={JSON.stringify(selectedOptions)}
        />
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
              <Text size="sm" tone="secondary">
                {selectedListingSeller} · {selectedListingAvailability}
              </Text>
              <Text size="sm" tone="secondary">
                <ProductCriteriaText
                  selections={productSelectionDetails}
                  summary={productSummary}
                  fallback={
                    productId
                      ? itemTitle
                      : t("discovery.routes.itemDetail.choose.options.to.add.this.product")
                  }
                />
              </Text>
            </Stack>
            {productId && visibleListingCount === 0 ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.add.to.cart.saves.buyer.intent")}</Text>
            ) : null}
            {actionMode === "all" ? (
              <Text size="sm" tone="secondary">
                {productIntentGuidance}
              </Text>
            ) : null}
            <Inline gap={2}>
              <BuyerProtectionBadge label={t("discovery.routes.itemDetail.buyer.protection.included")} />
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
        {addToCartError ? (
          <Banner tone="danger" title={addToCartError} />
        ) : null}
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

  return <FormPanel variant={panelVariant} glow={visibleListingCount > 0}>{form}</FormPanel>;
}

export function MarketplaceOfferMatchSection({
  formId = "sell-box",
  panelVariant = "card",
  showSummary = panelVariant === "card",
  actions,
  actionMode = "all",
  selectedOffer,
  productId,
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
    acceptance_terms?: MarketplaceListingTermsPreview | null;
  } | null;
  productId: string | null;
  matchingOfferCount: number;
  errorMessage?: string | null;
}) {
  const acceptedQuantity = selectedOffer?.quantity_requested ?? 0;
  const acceptedValue = selectedOffer
    ? multiplyMoneyAmount(selectedOffer.price_amount, acceptedQuantity)
    : null;
  const acceptanceTerms = selectedOffer?.acceptance_terms ?? null;
  const marketplaceFeeTotal =
    selectedOffer && acceptanceTerms
      ? multiplyMoneyAmount(
          acceptanceTerms.marketplace_sales_fee_unit_amount,
          acceptedQuantity,
        )
      : null;
  const sellerNetTotal =
    selectedOffer && acceptanceTerms
      ? multiplyMoneyAmount(
          acceptanceTerms.seller_net_unit_amount,
          acceptedQuantity,
        )
      : null;
  const shippingAllowanceAmount =
    acceptanceTerms && acceptedValue !== null
      ? (acceptedValue * acceptanceTerms.shipping_allowance_percentage_bps) / 10000
      : null;
  const quoteTime = acceptanceTerms
    ? new Date(acceptanceTerms.resolved_at).toLocaleString()
    : null;
  const sellNowAction = (
    <Button
      type="submit"
      name="intent"
      value="sell-now"
      disabled={!selectedOffer?.can_fulfill}
      block
    >
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
      {selectedOffer?.in_sell_list ? t("discovery.routes.itemDetail.in.sell.list") : t("discovery.routes.itemDetail.add.to.sell.list")}
    </Button>
  );
  const defaultActions = actionMode === "sell-now" ? (
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
                      {selectedOffer.can_fulfill ? t("discovery.routes.itemDetail.can.fulfill") : t("discovery.routes.itemDetail.needs.supply")}
                    </Badge>
                  </Inline>
                  <Text size="sm" tone="secondary">
                    {t("discovery.routes.itemDetail.offer.from.buyer", {
                      buyer: selectedOffer.buyer_display_name ?? selectedOffer.buyer_account_id,
                    })}
                  </Text>
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
                            percentage: formatAllowancePercentage(
                              acceptanceTerms.shipping_allowance_percentage_bps,
                            ),
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
  const selectedOfferQuote = selectedOffer
    ? createSellerRegistrationQuote(selectedOffer.price_amount)
    : null;
  const acceptedQuantity = selectedOffer?.quantity_requested ?? 0;
  const acceptedValue = selectedOffer
    ? multiplyMoneyAmount(selectedOffer.price_amount, acceptedQuantity)
    : null;
  const marketplaceFeeTotal =
    selectedOffer && selectedOfferQuote
      ? multiplyMoneyAmount(
          selectedOfferQuote.marketplace_sales_fee_unit_amount,
          acceptedQuantity,
        )
      : null;
  const sellerNetTotal =
    selectedOffer && selectedOfferQuote
      ? multiplyMoneyAmount(
          selectedOfferQuote.seller_net_unit_amount,
          acceptedQuantity,
        )
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
            <Text weight="semibold">
              {t("discovery.routes.itemDetail.accept.offer.after.registration")}
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
                          percentage: formatAllowancePercentage(
                            selectedOfferQuote.shipping_allowance_percentage_bps,
                          ),
                        }),
                      },
                      {
                        key: t("discovery.routes.itemDetail.product"),
                        value: (
                          <ProductSelectionSummary
                            selections={productSelectionDetails}
                            summary={
                              productSummary ??
                              t("discovery.routes.itemDetail.choose.options.to.sell.this.item")
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
                          <ProductSelectionSummary
                            selections={productSelectionDetails}
                            summary={
                              productSummary ??
                              t("discovery.routes.itemDetail.choose.options.to.sell.this.item")
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
                    <ProductSelectionSummary
                      selections={productSelectionDetails}
                      summary={
                        productSummary ??
                        t("discovery.routes.itemDetail.choose.options.to.sell.this.item")
                      }
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
                {t("discovery.routes.itemDetail.start.with")}{productSummary}
              </Text>
            ) : !selectedOffer ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.choose.product.options.first.then.register")}</Text>
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
            <TextInput label={t("discovery.routes.itemDetail.ship.from.postal.code")} name="shipFromPostalCode" required />
            <TextInput label={t("discovery.routes.itemDetail.ship.from.country")} name="shipFromCountry" defaultValue="US" required />
          </Inline>
          {errorMessage ? <Text>{errorMessage}</Text> : null}
          <Button type="submit" block>
            {t("discovery.routes.itemDetail.save.ship.from.setup")}</Button>
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
  const defaultActions = (
    listing ? (
      <LinkButton href={`/account/listings/${listing.listing_id}`} block>
        {t("discovery.routes.itemDetail.manage.listing")}</LinkButton>
    ) : (
      <Button
        type="submit"
        name="intent"
        value="list-at-price"
        disabled={!canUseListAction}
        block
      >
        {t("discovery.routes.itemDetail.list.at.price")}
      </Button>
    )
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
              {listing ? t("discovery.routes.itemDetail.update.your.listing") : t("discovery.routes.itemDetail.list.at.price.2")}
            </Text>
            {productSelectionDetails.length > 0 ? (
              <ProductSelectionSummary
                selections={productSelectionDetails}
                summary={productSummary ?? t("discovery.routes.itemDetail.choose.options.to.list.matching.inventory")}
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
        {listing ? (
          <input
            type="hidden"
            name="inventoryItemId"
            value={listing.inventory_item_id}
          />
        ) : null}
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
      <FormPanel variant={panelVariant} glow={Boolean(listing)}>{form}</FormPanel>
      {requiresShipFromSetup ? (
        <ListingStockShipFromSetupSection
          formId={`${formId}-ship-from-setup`}
          errorMessage={errorMessage}
        />
      ) : null}
    </Stack>
  );
}

type BuyAction = "buy-now" | "add-to-cart" | "make-offer" | "set-alert";
type SellAction = "sell-now" | "add-to-sell-list" | "list-for-sale" | "set-alert";

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
  glow?: boolean;
  showProductSummary?: boolean;
  footer?: ReactNode;
}) {
  return (
    <FormPanel variant={panelVariant} glow={glow}>
      <Stack gap={3}>
        <Stack gap={1}>
          <Text weight="semibold">{title}</Text>
          <Text size="sm" tone="secondary">{description}</Text>
          {showProductSummary ? (
            <ProductSelectionSummary
              selections={productSelectionDetails}
              summary={productSummary ?? t("discovery.routes.itemDetail.choose.options.to.select.product")}
              summaryAsChip={productSelectionDetails.length === 0}
            />
          ) : null}
        </Stack>
        {footer}
        <Accordion
          type="single"
          variant="sectionList"
          bleed={panelVariant === "plain" ? "compact" : "card"}
          value={selectedAction}
          onValueChange={(value) => {
            if (typeof value === "string") {
              onSelectedActionChange(value as TAction | "");
            }
          }}
          items={options.map((option) => ({
            value: option.value,
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
  productId,
  productSummary,
  productSelectionDetails,
  visibleListingCount,
  renderBuyNow,
  renderAddToCart,
  renderOffer,
  renderAlert,
}: {
  formIdPrefix: string;
  panelVariant?: FormPanelVariant;
  productId: string | null;
  productSummary: string | null;
  productSelectionDetails: readonly ProductSelectionDisplayDetail[];
  visibleListingCount: number;
  renderBuyNow: (formId: string) => ReactNode;
  renderAddToCart: (formId: string) => ReactNode;
  renderOffer: (formId: string) => ReactNode;
  renderAlert: (formId: string) => ReactNode;
}) {
  const defaultAction: BuyAction =
    productId && visibleListingCount > 0
      ? "buy-now"
      : productId
        ? "make-offer"
        : "set-alert";
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
    {
      value: "set-alert",
      label: t("discovery.routes.itemDetail.set.alert"),
      description: t("discovery.routes.itemDetail.set.alert.workflow.helper"),
      icon: "bell",
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
          : selectedAction === "set-alert"
            ? renderAlert(`${formIdPrefix}-listing-alert`)
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
  productId,
  productSummary,
  productSelectionDetails,
  hasMatchingOffer,
  canUseSellerFeatures,
  renderSellNow,
  renderAddToSellList,
  renderListing,
  renderAlert,
}: {
  formIdPrefix: string;
  panelVariant?: FormPanelVariant;
  productId: string | null;
  productSummary: string | null;
  productSelectionDetails: readonly ProductSelectionDisplayDetail[];
  hasMatchingOffer: boolean;
  canUseSellerFeatures: boolean;
  renderSellNow: (formId: string) => ReactNode;
  renderAddToSellList: (formId: string) => ReactNode;
  renderListing: (formId: string) => ReactNode;
  renderAlert: (formId: string) => ReactNode;
}) {
  const defaultAction: SellAction = hasMatchingOffer
    ? "sell-now"
    : productId
      ? "list-for-sale"
      : "set-alert";
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
      value: "list-for-sale",
      label: t("discovery.routes.itemDetail.list.for.sale"),
      description: t("discovery.routes.itemDetail.list.for.sale.action.description"),
      icon: "store",
      disabled: !productId,
    },
    {
      value: "set-alert",
      label: t("discovery.routes.itemDetail.set.alert"),
      description: t("discovery.routes.itemDetail.sell.alert.action.description"),
      icon: "bell",
      disabled: !productId,
    },
  ] satisfies readonly CommerceActionOption<SellAction>[];
  const selectedContent =
    selectedAction === "sell-now"
      ? renderSellNow(`${formIdPrefix}-sell-now`)
      : selectedAction === "add-to-sell-list"
        ? renderAddToSellList(`${formIdPrefix}-sell-list`)
        : selectedAction === "list-for-sale"
          ? renderListing(`${formIdPrefix}-list-for-sale`)
          : selectedAction === "set-alert"
            ? renderAlert(`${formIdPrefix}-offer-alert`)
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
      glow={hasMatchingOffer}
      showProductSummary={false}
      footer={
        <Badge tone="accent">
          {t("discovery.routes.itemDetail.same.buyer.shipping.allowance")}
        </Badge>
      }
    >
      {selectedContent}
    </ItemDetailActionCard>
  );
}

export function ItemCommercePanel({
  buyer,
  seller,
  showSellerTab,
}: {
  buyer: ReactNode;
  seller: ReactNode;
  showSellerTab: boolean;
}) {
  const [mode, setMode] = useState<"buy" | "sell">("buy");

  return (
    <Stack gap={3}>
      {showSellerTab ? (
        <SegmentedControl
          items={[
            { value: "buy", label: t("discovery.routes.itemDetail.buy") },
            { value: "sell", label: t("discovery.routes.itemDetail.sell") },
          ]}
          value={mode}
          onValueChange={(value) => setMode(value === "sell" ? "sell" : "buy")}
        />
      ) : null}
      {mode === "sell" && showSellerTab ? seller : buyer}
    </Stack>
  );
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createDiscoveryRequestApiClient(request);
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const inventoryApi = createInventoryRequestApiClient(request);
  const id = params.id;
  const url = new URL(request.url);
  const initialMarketIntent: "buy" | "sell" =
    url.searchParams.get("market") === "sell" ? "sell" : "buy";
  const initialSelectedOptions = readInitialSelectedOptions(url.searchParams);
  const initialSelectedOptionFiltersPresent = hasInitialSelectedOptionFilters(url.searchParams);

  if (!id) {
    return {
      item: null,
      accountOfferMatches: [],
      sellerInventoryItems: [],
      sellerAccountId: null,
      hasListingStockLocation: false,
      viewerAccountId: null,
      initialMarketIntent,
      initialSelectedOptions,
      hasInitialSelectedOptionFilters: initialSelectedOptionFiltersPresent,
      showSellerTab: false,
      canUseSellerFeatures: false,
      canSubmitOffers: false,
      registerToSellHref: buildRegisterToSellHref(request),
      notFound: true,
      canonicalUrl: null,
    };
  }

  try {
    const item = await api.getItemDetail(id);
    if (item.slug && id !== item.slug) {
      throw redirect(`/items/${item.slug}${url.search}`, { status: 301 });
    }

    const actor = await resolveActorFromAuthApi({ request });
    const canReviewAccountOfferMatches = Boolean(
      actor?.permissions.includes("offers.view") &&
        actor.permissions.includes("listings.view"),
    );
    const canSellOnItem = Boolean(
      actor?.permissions.includes("listings.view") &&
        actor.permissions.includes("listings.manage"),
    );
    const canSubmitOffers = Boolean(actor);
    let accountOfferMatches: DiscoveryOfferMatchWithTerms[] = [];
    let sellerInventoryItems: DiscoverySellerInventoryItem[] = [];
    let hasListingStockLocation = false;

    if (canReviewAccountOfferMatches) {
      try {
        const result = await marketplaceApi.listOfferMatches("limit=100&offset=0");
        const matchingOffers = result.items.filter(
          (offer) => offer.catalog_catalog_item_id === item.catalog_item_id,
        );
        accountOfferMatches = await Promise.all(
          matchingOffers.map(async (offer) => ({
            ...offer,
            acceptance_terms:
              offer.status === "submitted"
                ? await marketplaceApi.previewOfferAcceptanceTerms(offer.offer_id)
                : null,
          })),
        );
      } catch {
        accountOfferMatches = [];
      }
    }

    if (canSellOnItem) {
      try {
        const [items, storageLocations] = await Promise.all([
          marketplaceApi.listSellerListingInventory(
            `limit=100&offset=0&catalogItemId=${encodeURIComponent(item.catalog_item_id)}`,
          ),
          inventoryApi.listStorageLocations("limit=100&offset=0"),
        ]);
        sellerInventoryItems = (items.items as MarketplaceListingInventoryItemOption[])
          .map(toSellerInventoryItem);
        hasListingStockLocation = storageLocations.items.some(
          (location) => location.name === LISTING_STOCK_LOCATION_NAME,
        );
      } catch {
        sellerInventoryItems = [];
      }
    }

    return {
      item,
      accountOfferMatches,
      sellerInventoryItems,
      sellerAccountId: canSellOnItem ? actor?.accountId ?? null : null,
      hasListingStockLocation,
      viewerAccountId: actor?.accountId ?? null,
      initialMarketIntent,
      initialSelectedOptions,
      hasInitialSelectedOptionFilters: initialSelectedOptionFiltersPresent,
      showSellerTab: true,
      canUseSellerFeatures: canReviewAccountOfferMatches || canSellOnItem,
      canSubmitOffers,
      registerToSellHref: buildRegisterToSellHref(request),
      notFound: false,
      canonicalUrl: new URL(`/items/${item.slug || item.catalog_item_id}`, new URL(request.url).origin).toString(),
    };
  } catch (error) {
    if (error instanceof DiscoveryApiError) {
      return {
        item: null,
        accountOfferMatches: [],
        sellerInventoryItems: [],
        sellerAccountId: null,
        hasListingStockLocation: false,
        viewerAccountId: null,
        initialMarketIntent,
        initialSelectedOptions,
        hasInitialSelectedOptionFilters: initialSelectedOptionFiltersPresent,
        showSellerTab: false,
        canUseSellerFeatures: false,
        canSubmitOffers: false,
        registerToSellHref: buildRegisterToSellHref(request),
        notFound: true,
        canonicalUrl: null,
        error: error.message,
      };
    }

    return {
      item: null,
      accountOfferMatches: [],
      sellerInventoryItems: [],
      sellerAccountId: null,
      hasListingStockLocation: false,
      viewerAccountId: null,
      initialMarketIntent,
      initialSelectedOptions,
      hasInitialSelectedOptionFilters: initialSelectedOptionFiltersPresent,
      showSellerTab: false,
      canUseSellerFeatures: false,
      canSubmitOffers: false,
      registerToSellHref: buildRegisterToSellHref(request),
      notFound: true,
      canonicalUrl: null,
      error: error instanceof Error ? error.message : t("discovery.routes.itemDetail.item.not.found"),
    };
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const discoveryApi = createDiscoveryRequestApiClient(request);
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const inventoryApi = createInventoryRequestApiClient(request);
  const checkoutApi = createCheckoutRequestApiClient(request);

  try {
    if (intent === "create-product-alert") {
      await requireActorFromAuthApi({
        request,
        permission: "accounts.view",
      });
      const item = await discoveryApi.getItemDetail(params.id!);
      await discoveryApi.createProductAlert({
        marketSide: String(formData.get("marketSide") ?? "") === "offer"
          ? "offer"
          : "listing",
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        thresholdAmount: String(formData.get("thresholdAmount") ?? "") || null,
      });

      return redirect(`/items/${item.slug || item.catalog_item_id}?productAlertCreated=1`);
    }

    if (intent === "submit-offer") {
      const item = await discoveryApi.getItemDetail(params.id!);
      const query = new URLSearchParams({
        source: "offer-intent",
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle ?? "",
        selectedOptions: String(formData.get("selectedOptions") ?? "[]"),
        productSummary: String(formData.get("productSummary") ?? ""),
        offerPriceAmount: String(formData.get("priceAmount") ?? ""),
        quantity: String(formData.get("quantityRequested") ?? "1"),
      });

      return redirect(`/checkout/start?${query.toString()}`);
    }

    if (intent === "add-to-cart") {
      const actor = await resolveActorFromAuthApi({ request });
      const item = await discoveryApi.getItemDetail(params.id!);
      const cartLine = {
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        itemImageUrl: selectItemImageUrl(item, "thumbnail"),
        itemImageLoadingUrl: item.image_fallback?.url ?? null,
        itemImageLoadingAlt: item.image_fallback?.alt ?? null,
        itemImageLoadingSrcSet: imageVariantSrcSet(item.image_fallback, "thumbnail") ?? null,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity: Number(formData.get("quantity") ?? 0),
        fulfillmentMode: "optimize" as const,
        lockedListingId: null,
      };

      if (!canUseAccountCheckoutCart(actor)) {
        const anonymousCartId = ensureAnonymousCartId(request);
        await checkoutApi.addGuestCartLine(anonymousCartId, cartLine);
        const response = Response.json({
          status: "added-to-cart",
          itemTitle: item.title,
          quantity: cartLine.quantity,
        } satisfies AddToCartActionData);
        appendAnonymousCartCookie(response.headers, anonymousCartId);
        return response;
      }

      await checkoutApi.addCartLine(cartLine);

      return Response.json({
        status: "added-to-cart",
        itemTitle: item.title,
        quantity: cartLine.quantity,
      } satisfies AddToCartActionData);
    }

    if (intent === "buy-now" || intent === "buy-this-listing") {
      const actor = await resolveActorFromAuthApi({ request });
      const item = await discoveryApi.getItemDetail(params.id!);
      const lockedListingId =
        intent === "buy-this-listing"
          ? String(formData.get("lockedListingId") ?? formData.get("listingId") ?? "")
          : "";
      const source = {
        type: "buy-now",
        listingId: lockedListingId,
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity: Number(formData.get("quantity") ?? 0),
        fulfillmentMode: lockedListingId ? "locked-listing" as const : "optimize" as const,
        lockedListingId: lockedListingId || null,
      } as const;

      if (!canUseAccountCheckoutCart(actor)) {
        const query = new URLSearchParams({
          source: "buy-now",
          listingId: source.listingId,
          fulfillmentMode: source.fulfillmentMode,
          lockedListingId: source.lockedListingId ?? "",
          catalogItemId: source.catalogItemId,
          productId: source.productId,
          itemTitle: source.itemTitle,
          itemSubtitle: source.itemSubtitle ?? "",
          selectedOptions: JSON.stringify(source.selectedOptions),
          productSummary: source.productSummary ?? "",
          quantity: String(source.quantity),
          priceAmount: source.fulfillmentMode === "locked-listing" ? String(formData.get("priceAmount") ?? "") : "",
          sellerName: source.fulfillmentMode === "locked-listing" ? String(formData.get("sellerName") ?? "") : "",
          availability: source.fulfillmentMode === "locked-listing" ? String(formData.get("availability") ?? "") : "",
          fulfillment: t("discovery.routes.itemDetail.confirmed.at.checkout"),
        });
        return redirect(`/checkout/start?${query.toString()}`);
      }

      const session = await checkoutApi.createCheckoutSession({
        source,
      });

      return redirect(
        appendFreshWriteToken(`/checkout/${session.session_id}`, session),
      );
    }

    if (intent === "sell-now") {
      await requireActorFromAuthApi({
        request,
        permission: "offers.manage",
      });

      const offerId = String(formData.get("offerId") ?? "");
      await marketplaceApi.acceptOfferMatch(offerId, {
        feeQuoteFingerprint: String(formData.get("feeQuoteFingerprint") ?? ""),
      });
      return redirect("/account/sales");
    }

    if (intent === "add-to-sell-list") {
      await requireActorFromAuthApi({
        request,
        permission: "offers.manage",
      });

      await marketplaceApi.addOfferMatchSellListItem({
        offerId: String(formData.get("offerId") ?? ""),
      });
      return redirect("/account/offers/matches");
    }

    if (intent === "create-listing-stock-location") {
      await requireActorFromAuthApi({
        request,
        permission: "listings.manage",
      });
      const item = await discoveryApi.getItemDetail(params.id!);
      const shipFromAddress = shipFromAddressFromForm(formData);

      if (!shipFromAddress) {
        throw new Error(t("discovery.routes.itemDetail.ship.from.setup.required"));
      }

      await inventoryApi.createStorageLocation({
        name: LISTING_STOCK_LOCATION_NAME,
        description: LISTING_STOCK_LOCATION_DESCRIPTION,
        shipFromCode: LISTING_STOCK_SHIP_FROM_CODE,
        shipFromAddress,
      });

      return redirect(`/items/${item.slug || item.catalog_item_id}?market=sell`);
    }

    if (intent === "list-at-price") {
      await requireActorFromAuthApi({
        request,
        permission: "listings.manage",
      });
      const item = await discoveryApi.getItemDetail(params.id!);

      const listingId = String(formData.get("listingId") ?? "").trim();
      const priceAmount = String(formData.get("priceAmount") ?? "");
      const quantityCap = Number(formData.get("quantityCap") ?? 0);

      if (listingId) {
        const quote = await marketplaceApi.previewListingTerms({ priceAmount });
        await marketplaceApi.updateListingPrice(listingId, {
          priceAmount,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        });
        await marketplaceApi.updateListingQuantityCap(listingId, {
          quantityCap,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        });
        return redirect(`/items/${item.slug || params.id}`);
      }

      const inventoryItemId = String(formData.get("inventoryItemId") ?? "").trim();
      const listingBody = inventoryItemId
        ? {
            inventoryItemId,
            priceAmount,
            quantityCap,
          }
        : {
            inventoryItemId: "",
            priceAmount,
            quantityCap,
            inventorySnapshot: (
              await inventoryApi.ensureListingStock({
                catalogItemId: item.catalog_item_id,
                selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
                quantity: quantityCap,
              })
            ).snapshot,
          };
      const result = await marketplaceApi.createListing(listingBody) as { id?: string; feeQuoteFingerprint?: string };

      if (result.id) {
        await marketplaceApi.publishListing(result.id, {
          feeQuoteFingerprint: result.feeQuoteFingerprint,
        });
      }

      return redirect(`/items/${item.slug || params.id}`);
    }

    return null;
  } catch (error) {
    if (error instanceof Error) {
      return {
        error: error.message,
      };
    }

    throw error;
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  ...buildOpenGraphMeta({
    title: data?.item
      ? `${data.item.title} | Marketplace`
      : t("discovery.routes.itemDetail.item.not.found.marketplace"),
    description: data?.item?.description
      ? data.item.description
      : MARKETPLACE_DESCRIPTION,
    imageUrl: data?.item
      ? selectItemImageUrl(data.item, "catalog-detail") ?? discoveryAssetUrls.defaultProductImage
      : undefined,
    type: data?.item ? "product" : "website",
  }),
  ...(data?.canonicalUrl
    ? [{ tagName: "link", rel: "canonical", href: data.canonicalUrl }]
    : []),
];

export default function DiscoveryItemDetailRoute() {
  const data = useLoaderData<typeof loader>() ?? EMPTY_ITEM_DETAIL_RESULT;
  const actionData = useActionData<typeof action>();

  return (
    <DiscoveryItemDetailRealtimeView
      key={[
        data.item?.catalog_item_id ?? "empty",
        data.item?.market_listings.map((listing) => listing.listing_id).join("|") ?? "",
        data.item?.buyer_offer_matches.map((offer) => offer.offer_id).join("|") ?? "",
      ].join("\n")}
      data={data}
      actionData={actionData}
    />
  );
}

type DiscoveryItemDetailRouteData =
  | typeof EMPTY_ITEM_DETAIL_RESULT
  | Awaited<ReturnType<typeof loader>>;
type DiscoveryItemDetailActionData =
  | Exclude<Awaited<ReturnType<typeof action>>, Response>
  | undefined;

function DiscoveryItemDetailRealtimeView({
  data,
  actionData,
}: {
  data: DiscoveryItemDetailRouteData;
  actionData: DiscoveryItemDetailActionData;
}) {
  const actionErrorMessage = getActionErrorMessage(actionData);
  const realtimeItem = useRealtimePatchedSnapshot({
    initialSnapshot: data.item,
    snapshotKey: JSON.stringify(data.item),
    topics: data.item
      ? discoveryRealtimeRouteTopics.itemDetail(data.item.catalog_item_id).topics
      : [],
    applyPatch: applyDiscoveryItemPatch,
    onSyncRequired: reloadForRealtimeSync,
  });

  return (
    <ItemDetailPage
      data={realtimeItem}
      accountOfferMatches={data.accountOfferMatches}
      viewerAccountId={data.viewerAccountId}
      initialMarketIntent={data.initialMarketIntent}
      initialSelectedOptions={data.initialSelectedOptions}
      hasInitialSelectedOptionFilters={data.hasInitialSelectedOptionFilters}
      notFound={data.notFound}
      error={data.error}
      renderCommerce={
        data.item
          ? (context) => {
              const ownListing = data.sellerAccountId && context.selectedProductId
                ? context.visibleListings.find(
                    (listing) =>
                      listing.account_id === data.sellerAccountId &&
                      listing.product_id === context.selectedProductId,
                  ) ?? null
                : null;
              const renderBuy = (
                formId: string,
                panelVariant: FormPanelVariant = "card",
                actions?: ReactNode,
                showSummary?: boolean,
                actionMode?: "all" | "buy-now" | "add-to-cart",
              ) => (
                <CheckoutPurchaseIntentSection
                  formId={formId}
                  panelVariant={panelVariant}
                  showSummary={showSummary}
                  actions={actions}
                  actionMode={actionMode}
                  catalogItemId={context.itemId}
                  productId={context.selectedProductId}
                  selectedListing={context.selectedListing}
                  itemTitle={context.itemTitle}
                  selectedOptions={context.selectedProductOptions}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  productSummary={context.selectedProductSummary}
                  visibleListingCount={context.visibleListings.length}
                  errorMessage={actionErrorMessage}
                />
              );
              const renderProductAlert = (
                formId: string,
                marketSide: "listing" | "offer",
                panelVariant: FormPanelVariant = "card",
                showSummary?: boolean,
              ) => (
                <ProductAlertCreationSection
                  formId={formId}
                  panelVariant={panelVariant}
                  showSummary={showSummary}
                  marketSide={marketSide}
                  catalogItemId={context.itemId}
                  productId={context.selectedProductId}
                  selectedOptions={context.selectedProductOptions}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  productSummary={context.selectedProductSummary}
                />
              );
              const renderOffer = (
                formId: string,
                panelVariant: FormPanelVariant = "card",
                actions?: ReactNode,
                showSummary?: boolean,
              ) => (
                <MarketplaceOfferSubmissionSection
                  formId={formId}
                  panelVariant={panelVariant}
                  showSummary={showSummary}
                  actions={actions}
                  catalogItemId={context.itemId}
                  productId={context.selectedProductId}
                  itemTitle={context.itemTitle}
                  selectedOptions={context.selectedProductOptions}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  productSummary={context.selectedProductSummary}
                  visibleListingCount={context.visibleListings.length}
                  errorMessage={actionErrorMessage}
                />
              );
              const renderOfferMatch = (
                formId: string,
                panelVariant: FormPanelVariant = "card",
                actions?: ReactNode,
                showSummary?: boolean,
                actionMode?: "all" | "sell-now" | "add-to-sell-list",
              ) => (
                <MarketplaceOfferMatchSection
                  formId={formId}
                  panelVariant={panelVariant}
                  showSummary={showSummary}
                  actions={actions}
                  actionMode={actionMode}
                  selectedOffer={context.selectedAccountOfferMatch}
                  productId={context.selectedProductId}
                  matchingOfferCount={context.visibleAccountOfferMatches.length}
                  errorMessage={actionErrorMessage}
                />
              );
              const renderListingSubmission = (
                formId: string,
                panelVariant: FormPanelVariant = "card",
                actions?: ReactNode,
                showSummary?: boolean,
              ) => (
                <MarketplaceListingSubmissionSection
                  formId={formId}
                  panelVariant={panelVariant}
                  showSummary={showSummary}
                  actions={actions}
                  productId={context.selectedProductId}
                  selectedOptions={context.selectedProductOptions}
                  productSummary={context.selectedProductSummary}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  bestListing={context.bestListing}
                  ownListing={ownListing}
                  hasListingStockLocation={data.hasListingStockLocation}
                  errorMessage={actionErrorMessage}
                />
              );
              const renderSellerRegistration = (
                panelVariant: FormPanelVariant = "card",
                showSummary?: boolean,
                mode?: "combined" | "offer" | "listing",
              ) => (
                <MarketplaceSellerRegistrationSection
                  panelVariant={panelVariant}
                  showSummary={showSummary}
                  mode={mode}
                  productSummary={context.selectedProductSummary}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  selectedOffer={context.selectedOffer}
                  matchingOfferCount={context.visibleOffers.length}
                  registerHref={data.registerToSellHref}
                />
              );
              const renderBuyActionCard = (
                formIdPrefix: string,
                panelVariant: FormPanelVariant = "card",
              ) => (
                <BuyActionCard
                  formIdPrefix={formIdPrefix}
                  panelVariant={panelVariant}
                  productId={context.selectedProductId}
                  productSummary={context.selectedProductSummary}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  visibleListingCount={context.visibleListings.length}
                  renderBuyNow={(formId) =>
                    renderBuy(formId, "plain", undefined, true, "buy-now")
                  }
                  renderAddToCart={(formId) =>
                    renderBuy(formId, "plain", undefined, true, "add-to-cart")
                  }
                  renderOffer={(formId) =>
                    renderOffer(formId, "plain", undefined, true)
                  }
                  renderAlert={(formId) =>
                    renderProductAlert(formId, "listing", "plain", true)
                  }
                />
              );
              const renderSellActionCard = (
                formIdPrefix: string,
                panelVariant: FormPanelVariant = "card",
              ) => (
                <SellActionCard
                  formIdPrefix={formIdPrefix}
                  panelVariant={panelVariant}
                  productId={context.selectedProductId}
                  productSummary={context.selectedProductSummary}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  hasMatchingOffer={
                    data.canUseSellerFeatures
                      ? Boolean(context.selectedAccountOfferMatch)
                      : context.visibleOffers.length > 0
                  }
                  canUseSellerFeatures={data.canUseSellerFeatures}
                  renderSellNow={(formId) =>
                    data.canUseSellerFeatures
                      ? renderOfferMatch(formId, "plain", undefined, true, "sell-now")
                      : renderSellerRegistration("plain", true, "offer")
                  }
                  renderAddToSellList={(formId) =>
                    data.canUseSellerFeatures
                      ? renderOfferMatch(formId, "plain", undefined, true, "add-to-sell-list")
                      : renderSellerRegistration("plain", true, "offer")
                  }
                  renderListing={(formId) =>
                    data.canUseSellerFeatures
                      ? renderListingSubmission(formId, "plain", undefined, true)
                      : renderSellerRegistration("plain", true, "listing")
                  }
                  renderAlert={(formId) =>
                    data.viewerAccountId
                      ? renderProductAlert(formId, "offer", "plain", true)
                      : renderSellerRegistration("plain", true, "offer")
                  }
                />
              );
              return (
                {
                  buy: renderBuyActionCard("buy-card", "plain"),
                  offer: null,
                  sell: data.showSellerTab ? renderSellActionCard("sell-card", "plain") : undefined,
                  mobile: {
                    buy: {
                      content: renderBuyActionCard("mobile-buy-card", "plain"),
                      title: t("discovery.routes.itemDetail.buy"),
                    },
                    sell: {
                      content: renderSellActionCard("mobile-sell-card", "plain"),
                      title: t("discovery.routes.itemDetail.sell.2"),
                    },
                  },
                  sellLabel: data.canUseSellerFeatures ? t("discovery.routes.itemDetail.sell.2") : t("discovery.routes.itemDetail.sell.3"),
                }
              );
            }
          : undefined
      }
    />
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
