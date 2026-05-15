import { t } from "@chase-sets/localization";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { redirect, useActionData, useFetcher, useLoaderData } from "react-router";
import {
  Badge,
  Banner,
  BuyerProtectionBadge,
  Button,
  CurrencyInput,
  FormPanel,
  type FormPanelVariant,
  Grid,
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
  DiscoveryMarketListing,
  DiscoverySellerInventoryItem,
  DiscoveryAccountOfferMatch,
} from "../support/client-support/contracts";
import { discoveryAssetUrls } from "../support/client-support/assets";
import {
  createMarketplaceRequestApiClient,
  type MarketplaceListingInventoryItemOption,
  type MarketplaceListingTermsPreview,
} from "@chase-sets/marketplace/server";
import {
  appendAnonymousCartCookie,
  createCheckoutRequestApiClient,
  ensureAnonymousCartId,
} from "@chase-sets/checkout/server";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";

const MARKETPLACE_DESCRIPTION =
  t("discovery.routes.itemDetail.browse.the.chase.sets.marketplace.with");

const EMPTY_ITEM_DETAIL_RESULT = {
  item: null,
  accountOfferMatches: [],
  sellerInventoryItems: [],
  sellerAccountId: null,
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

function ProductAlertCreationSection({
  formId,
  marketSide,
  productId,
  catalogItemId,
  selectedOptions,
  productSelectionDetails = [],
  productSummary,
}: {
  formId: string;
  marketSide: "listing" | "offer";
  productId: string | null;
  catalogItemId: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSelectionDetails?: readonly ProductSelectionDisplayDetail[];
  productSummary: string | null;
}) {
  const isListingAlert = marketSide === "listing";

  return (
    <FormPanel variant="card">
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
          <Stack gap={1}>
            <Text weight="semibold">
              {isListingAlert ? "Watch for listings" : "Watch for offers"}
            </Text>
            <ProductSelectionSummary
              selections={productSelectionDetails}
              summary={productSummary ?? "Selected product"}
              summaryAsChip={productSelectionDetails.length === 0}
            />
            <Text size="sm" tone="secondary">
              {isListingAlert
                ? "Get a web notification when a matching listing appears at your price."
                : "Get a web notification when matching offer demand appears at your price."}
            </Text>
          </Stack>
          <CurrencyInput
            label={isListingAlert ? "Maximum listing price" : "Minimum offer price"}
            name="thresholdAmount"
            placeholder={isListingAlert ? "25.00" : "15.00"}
            min="0"
            step="0.01"
          />
          <Button type="submit" tone="secondary" disabled={!productId} block>
            {t("discovery.routes.itemDetail.create.product.alert")}
          </Button>
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
    <Button type="submit" tone="secondary" disabled={!productId} block>
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
          <Stack gap={1}>
            <Text weight="semibold">{t("discovery.routes.itemDetail.make.an.offer")}</Text>
            {productSelectionDetails.length > 0 ? (
              <ProductSelectionSummary
                selections={productSelectionDetails}
                summary={productSummary ?? itemTitle}
              />
            ) : (
              <Text size="sm" tone="secondary">
                {productSummary
                  ? t("discovery.routes.itemDetail.offer.for.product", { productSummary })
                  : itemTitle}
              </Text>
            )}
            <Text size="sm" tone="secondary">
              {productId
                ? t("discovery.routes.itemDetail.listing.match.count", {
                    count: visibleListingCount,
                    listingLabel: t(
                      visibleListingCount === 1
                        ? "discovery.routes.itemDetail.listing.singular"
                        : "discovery.routes.itemDetail.listing.plural",
                    ),
                  })
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
  const productIntentGuidance = productId
    ? visibleListingCount === 0
        ? t("discovery.routes.itemDetail.product.intent.no.supply.guidance")
        : t("discovery.routes.itemDetail.product.intent.buy.guidance")
      : t("discovery.routes.itemDetail.product.intent.choose.options.guidance");
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
  const defaultActions = (
    <>
      <Button
        type="submit"
        name="intent"
        value="buy-now"
        tone={productId ? "primary" : "secondary"}
        disabled={!productId}
        block
      >
        {t("discovery.routes.itemDetail.buy.optimized")}
      </Button>
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
      <Button
        type="button"
        tone="secondary"
        disabled={!productId || Boolean(addToCartPending)}
        onClick={() => {
          void handleAddToCart();
        }}
        block
      >
        {addToCartPending
            ? t("discovery.routes.itemDetail.adding.to.cart")
            : t("discovery.routes.itemDetail.add.product.to.cart")}</Button>
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
          <Stack gap={2}>
            <Text weight="semibold">{t("discovery.routes.itemDetail.selected.product.intent")}</Text>
            <KeyValueList
              density="compact"
              variant="plain"
              items={[
                {
                  key: selectedListing
                    ? t("discovery.routes.itemDetail.selected.seller.signal")
                    : t("discovery.routes.itemDetail.market.signal"),
                  value: selectedListingPrice,
                },
                {
                  key: selectedListing
                    ? t("discovery.routes.itemDetail.selected.seller")
                    : t("discovery.routes.itemDetail.seller.options"),
                  value: selectedListingSeller,
                },
                {
                  key: t("discovery.routes.itemDetail.availability"),
                  value: selectedListingAvailability,
                },
                {
                  key: t("discovery.routes.itemDetail.product"),
                  value: (
                    <ProductSelectionSummary
                      selections={productSelectionDetails}
                      summary={
                        productSummary ??
                        (productId
                          ? itemTitle
                          : t("discovery.routes.itemDetail.choose.options.to.add.this.product"))
                      }
                    />
                  ),
                },
              ]}
            />
            {productId && visibleListingCount === 0 ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.add.to.cart.saves.buyer.intent")}</Text>
            ) : null}
            <Text size="sm" tone="secondary">
              {productIntentGuidance}
            </Text>
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
  selectedOffer,
  productId,
  matchingOfferCount,
  errorMessage,
}: {
  formId?: string;
  panelVariant?: FormPanelVariant;
  showSummary?: boolean;
  actions?: ReactNode;
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
  const defaultActions = (
    <>
      <Button
        type="submit"
        name="intent"
        value="sell-now"
        disabled={!selectedOffer?.can_fulfill}
        block
      >
        {t("discovery.routes.itemDetail.sell.now")}</Button>
      <Button
        type="submit"
        name="intent"
        value="add-to-sell-list"
        tone="secondary"
        disabled={!selectedOffer?.can_fulfill || selectedOffer.in_sell_list}
        block
      >
        {selectedOffer?.in_sell_list ? t("discovery.routes.itemDetail.in.sell.list") : t("discovery.routes.itemDetail.add.to.sell.list")}
      </Button>
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

function MarketplaceListingSubmissionSection({
  formId = "list-box",
  panelVariant = "card",
  showSummary = panelVariant === "card",
  actions,
  productId,
  productSummary,
  productSelectionDetails = [],
  bestListing,
  ownListing,
  inventoryItems,
  errorMessage,
}: {
  formId?: string;
  panelVariant?: FormPanelVariant;
  showSummary?: boolean;
  actions?: ReactNode;
  productId: string | null;
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
  inventoryItems: readonly DiscoverySellerInventoryItem[];
  errorMessage?: string | null;
}) {
  const matchingInventory = productId
    ? inventoryItems.filter((inventoryItem) => inventoryItem.product_id === productId)
    : [];
  const selectedInventory = matchingInventory[0] ?? null;
  const listing = ownListing ?? null;
  const availableQuantity = listing?.quantity_cap ?? selectedInventory?.available_quantity ?? 0;
  const defaultQuantity = Math.max(1, Math.min(availableQuantity, 1));
  const defaultActions = (
    <Button
      type="submit"
      name="intent"
      value="list-at-price"
      disabled={!productId || (!listing && matchingInventory.length === 0)}
      block
    >
      {listing ? t("discovery.routes.itemDetail.update.listing") : t("discovery.routes.itemDetail.list.at.price")}
    </Button>
  );

  const form = (
    <form id={formId} method="post">
      <Stack gap={3}>
        <input type="hidden" name="productId" value={productId ?? ""} />
        <input type="hidden" name="listingId" value={listing?.listing_id ?? ""} />
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
        ) : (
          <NativeSelect
            label={t("discovery.routes.itemDetail.inventory")}
            name="inventoryItemId"
            defaultValue={selectedInventory?.item_id ?? ""}
            items={[
              { value: "", label: t("discovery.routes.itemDetail.choose.inventory") },
              ...matchingInventory.map((inventoryItem) => ({
                value: inventoryItem.item_id,
                label: t("discovery.routes.itemDetail.inventory.option.label", {
                  productSummary: inventoryItem.product_summary ?? t("discovery.routes.itemDetail.selected.product"),
                  availableQuantity: inventoryItem.available_quantity,
                }),
              })),
            ]}
            required
          />
        )}
        <CurrencyInput
          label={t("discovery.routes.itemDetail.listing.price")}
          name="priceAmount"
          defaultValue={listing?.price_amount ?? bestListing?.price_amount ?? ""}
          required
        />
        <NumberInput
          label={t("discovery.routes.itemDetail.quantity.to.list")}
          name="quantityCap"
          min={1}
          max={Math.max(availableQuantity, 1)}
          defaultValue={String(listing?.quantity_cap ?? defaultQuantity)}
          required
        />
        {errorMessage ? <Text>{errorMessage}</Text> : null}
        {actions !== undefined ? actions : defaultActions}
      </Stack>
    </form>
  );

  return <FormPanel variant={panelVariant} glow={Boolean(listing)}>{form}</FormPanel>;
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
        const items = await marketplaceApi.listSellerListingInventory(
          `limit=100&offset=0&catalogItemId=${encodeURIComponent(item.catalog_item_id)}`,
        );
        sellerInventoryItems = (items.items as MarketplaceListingInventoryItemOption[])
          .map(toSellerInventoryItem);
      } catch {
        sellerInventoryItems = [];
      }
    }

    return {
      item,
      accountOfferMatches,
      sellerInventoryItems,
      sellerAccountId: canSellOnItem ? actor?.accountId ?? null : null,
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
        itemImageUrl: Array.isArray(item.image_urls) ? item.image_urls[0] ?? null : null,
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

      const result = await marketplaceApi.createListing({
        inventoryItemId: String(formData.get("inventoryItemId") ?? ""),
        priceAmount,
        quantityCap,
      }) as { id?: string; feeQuoteFingerprint?: string };

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
      ? data.item.image_urls[0] ?? discoveryAssetUrls.defaultProductImage
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
              ) => (
                <CheckoutPurchaseIntentSection
                  formId={formId}
                  panelVariant={panelVariant}
                  showSummary={showSummary}
                  actions={actions}
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
              ) => (
                <ProductAlertCreationSection
                  formId={formId}
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
              ) => (
                <MarketplaceOfferMatchSection
                  formId={formId}
                  panelVariant={panelVariant}
                  showSummary={showSummary}
                  actions={actions}
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
                  productSummary={context.selectedProductSummary}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  bestListing={context.bestListing}
                  ownListing={ownListing}
                  inventoryItems={data.sellerInventoryItems}
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
              const renderSeller = (formIdPrefix: string) =>
                data.canUseSellerFeatures ? (
                  <Stack gap={4}>
                    {renderOfferMatch(`${formIdPrefix}-sell-box`)}
                    {renderListingSubmission(`${formIdPrefix}-list-box`)}
                  </Stack>
                ) : renderSellerRegistration();
              return (
                {
                  buy: (
                    <Stack gap={4}>
                      {renderBuy("buy-box")}
                      {renderProductAlert("listing-product-alert", "listing")}
                    </Stack>
                  ),
                  offer: (
                    <Stack gap={4}>
                      {renderOffer("make-offer")}
                      {renderProductAlert("offer-product-alert", "offer")}
                    </Stack>
                  ),
                  sell: data.showSellerTab ? renderSeller("sell") : undefined,
                  mobile: {
                    buy: {
                      content: (
                        <Stack gap={4}>
                          {renderBuy("mobile-buy-box", "plain", undefined, true)}
                          {renderProductAlert("mobile-listing-product-alert", "listing")}
                        </Stack>
                      ),
                      title: t("discovery.routes.itemDetail.buy"),
                    },
                    offer: {
                      content: (
                        <Stack gap={4}>
                          {renderOffer("mobile-make-offer", "plain", undefined, true)}
                          {renderProductAlert("mobile-offer-product-alert", "offer")}
                        </Stack>
                      ),
                      title: t("discovery.routes.itemDetail.make.an.offer"),
                    },
                    sell: data.canUseSellerFeatures
                      ? {
                          content: renderOfferMatch("mobile-sell-box", "plain", undefined, true),
                          title: t("discovery.routes.itemDetail.sell.2"),
                        }
                      : {
                          content: renderSellerRegistration("plain", true, "offer"),
                          title: t("discovery.routes.itemDetail.sell.on.chase.sets.2"),
                        },
                    list: data.canUseSellerFeatures
                      ? {
                          content: renderListingSubmission("mobile-list-box", "plain", undefined, true),
                          title: t("discovery.routes.itemDetail.list"),
                        }
                      : {
                          content: renderSellerRegistration("plain", true, "listing"),
                          title: t("discovery.routes.itemDetail.list"),
                        },
                  },
                  sellLabel: data.canUseSellerFeatures ? t("discovery.routes.itemDetail.sell.2") : t("discovery.routes.itemDetail.sell.3"),
                  listLabel: t("discovery.routes.itemDetail.list"),
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
