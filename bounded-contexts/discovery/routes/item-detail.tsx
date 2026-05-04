import { t } from "@chase-sets/localization";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { useState, type ReactNode } from "react";
import { redirect, useActionData, useLoaderData } from "react-router";
import {
  Badge,
  Button,
  CurrencyInput,
  FormPanel,
  type FormPanelVariant,
  LinkButton,
  NativeSelect,
  NumberInput,
  SegmentedControl,
  Stack,
  Text,
} from "@chase-sets/design-system";
import {
  requireActorFromAuthApi,
  resolveActorFromAuthApi,
} from "@chase-sets/platform-runtime/auth";
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
  showSellerTab: true,
  canUseSellerFeatures: false,
  registerToSellHref: "/register",
  notFound: false,
  error: null,
  canonicalUrl: null,
} as const;

type DiscoveryOfferMatchWithTerms = DiscoveryAccountOfferMatch & Readonly<{
  acceptance_terms: MarketplaceListingTermsPreview | null;
}>;

function formatAllowancePercentage(bps: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(bps / 100)}%`;
}

function buildRegisterToSellHref(request: Request) {
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;

  return `/register?returnTo=${encodeURIComponent(returnTo)}`;
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

function MarketplaceOfferSubmissionSection({
  formId = "make-offer",
  panelVariant = "card",
  showSummary = panelVariant === "card",
  actions,
  catalogItemId,
  productId,
  itemTitle,
  selectedOptions,
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
            <Text size="sm" tone="secondary">
              {productSummary
                ? t("discovery.routes.itemDetail.offer.for.product", { productSummary })
                : itemTitle}
            </Text>
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
    visible_quantity: number;
  } | null;
  itemTitle: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  visibleListingCount: number;
  errorMessage?: string | null;
}) {
  const defaultActions = (
    <>
      <Button
        type="submit"
        name="intent"
        value="buy-now"
        disabled={!productId || !selectedListing}
        block
      >
        {t("discovery.routes.itemDetail.buy.now")}</Button>
      <Button
        type="submit"
        name="intent"
        value="add-to-cart"
        tone="secondary"
        disabled={!productId}
        block
      >
        {t("discovery.routes.itemDetail.add.to.cart")}</Button>
    </>
  );
  const form = (
    <form id={formId} method="post">
      <Stack gap={3}>
        <input type="hidden" name="catalogItemId" value={catalogItemId} />
        <input type="hidden" name="listingId" value={selectedListing?.listing_id ?? ""} />
        <input type="hidden" name="productId" value={productId ?? ""} />
        <input
          type="hidden"
          name="selectedOptions"
          value={JSON.stringify(selectedOptions)}
        />
        <input type="hidden" name="productSummary" value={productSummary ?? ""} />
        {showSummary ? (
          <Stack gap={1}>
            <Text weight="semibold">{t("discovery.routes.itemDetail.buy.selected.product")}</Text>
            <Text size="sm" tone="secondary">
              {productSummary
                ? t("discovery.routes.itemDetail.buying.product", { productSummary })
                : itemTitle}
            </Text>
            {selectedListing ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.selected.listing.summary", {
                  price: selectedListing.price_amount,
                  seller: selectedListing.seller_display_name ?? t("discovery.routes.itemDetail.seller"),
                })}
              </Text>
            ) : null}
            {selectedListing ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.selected.listing.shipping.credit", {
                  percentage: formatAllowancePercentage(selectedListing.shipping_allowance_percentage_bps),
                })}
              </Text>
            ) : null}
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
                : t("discovery.routes.itemDetail.choose.options.to.add.this.product")}
            </Text>
            {productId && visibleListingCount === 0 ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.add.to.cart.saves.buyer.intent")}</Text>
            ) : null}
          </Stack>
        ) : null}
        {errorMessage ? <Text>{errorMessage}</Text> : null}
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

function MarketplaceOfferMatchSection({
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
                <Text size="sm" tone="secondary">
                  {t("discovery.routes.itemDetail.selected.offer.summary", {
                    price: selectedOffer.price_amount,
                    buyer: selectedOffer.buyer_display_name ?? selectedOffer.buyer_account_id,
                  })}
                </Text>
                <Text size="sm" tone="secondary">
                  {t("discovery.routes.itemDetail.selected.offer.supply.summary", {
                    requested: selectedOffer.quantity_requested,
                    available: selectedOffer.seller_available_quantity,
                  })}
                </Text>
                {selectedOffer.acceptance_terms ? (
                  <>
                    <Text size="sm" tone="secondary">
                      {t("discovery.routes.itemDetail.offer.marketplace.fee", {
                        amount: selectedOffer.acceptance_terms.marketplace_sales_fee_unit_amount,
                      })}
                    </Text>
                    <Text size="sm" tone="secondary">
                      {t("discovery.routes.itemDetail.offer.seller.net", {
                        amount: selectedOffer.acceptance_terms.seller_net_unit_amount,
                      })}
                    </Text>
                    <Text size="sm" tone="secondary">
                      {t("discovery.routes.itemDetail.offer.shipping.allowance", {
                        percentage: formatAllowancePercentage(
                          selectedOffer.acceptance_terms.shipping_allowance_percentage_bps,
                        ),
                      })}
                    </Text>
                    <Text size="sm" tone="secondary">
                      {t("discovery.routes.itemDetail.offer.terms.source", {
                        source:
                          selectedOffer.acceptance_terms.agreement_id ??
                          selectedOffer.acceptance_terms.schedule_id ??
                          t("discovery.routes.itemDetail.standard.terms"),
                      })}
                    </Text>
                    <Text size="sm" tone="secondary">
                      {t("discovery.routes.itemDetail.offer.quote.time", {
                        time: new Date(
                          selectedOffer.acceptance_terms.resolved_at,
                        ).toLocaleString(),
                      })}
                    </Text>
                  </>
                ) : null}
                <Badge tone={selectedOffer.can_fulfill ? "success" : "warning"}>
                  {selectedOffer.can_fulfill ? t("discovery.routes.itemDetail.can.fulfill") : t("discovery.routes.itemDetail.needs.supply")}
                </Badge>
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
  productSummary,
  registerHref,
}: {
  panelVariant?: FormPanelVariant;
  showSummary?: boolean;
  productSummary: string | null;
  registerHref: string;
}) {
  const content = (
    <Stack gap={3}>
      {showSummary ? (
        <Stack gap={1}>
          <Text weight="semibold">{t("discovery.routes.itemDetail.sell.on.chase.sets")}</Text>
          <Text size="sm" tone="secondary">
            {t("discovery.routes.itemDetail.register.to.list.inventory.buy.cards")}</Text>
          {productSummary ? (
            <Text size="sm" tone="secondary">
              {t("discovery.routes.itemDetail.start.with")}{productSummary}
            </Text>
          ) : (
            <Text size="sm" tone="secondary">
              {t("discovery.routes.itemDetail.choose.product.options.first.then.register")}</Text>
          )}
        </Stack>
      ) : null}
      <LinkButton href={registerHref} leadingIcon="plus" block>
        {t("discovery.routes.itemDetail.register.to.sell")}</LinkButton>
    </Stack>
  );

  return <FormPanel variant={panelVariant} glow>{content}</FormPanel>;
}

function MarketplaceListingSubmissionSection({
  formId = "list-box",
  panelVariant = "card",
  showSummary = panelVariant === "card",
  actions,
  productId,
  productSummary,
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
            <Text size="sm" tone="secondary">
              {productSummary
                ? t("discovery.routes.itemDetail.selling.product", { productSummary })
                : t("discovery.routes.itemDetail.choose.options.to.list.matching.inventory")}
            </Text>
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

  if (!id) {
    return {
      item: null,
      accountOfferMatches: [],
      sellerInventoryItems: [],
      sellerAccountId: null,
      showSellerTab: false,
      canUseSellerFeatures: false,
      registerToSellHref: buildRegisterToSellHref(request),
      notFound: true,
      canonicalUrl: null,
    };
  }

  try {
    const item = await api.getItemDetail(id);
    const url = new URL(request.url);
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
      showSellerTab: true,
      canUseSellerFeatures: canReviewAccountOfferMatches || canSellOnItem,
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
        showSellerTab: false,
        canUseSellerFeatures: false,
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
      showSellerTab: false,
      canUseSellerFeatures: false,
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
    if (intent === "submit-offer") {
      await requireActorFromAuthApi({
        request,
        permission: "offers.manage",
      });
      const item = await discoveryApi.getItemDetail(params.id!);

      await marketplaceApi.createSubmittedOffer({
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        priceAmount: formData.get("priceAmount"),
        quantityRequested: Number(formData.get("quantityRequested") ?? 0),
      });

      return redirect("/account/offers/submitted");
    }

    if (intent === "add-to-cart") {
      const actor = await resolveActorFromAuthApi({ request });
      const item = await discoveryApi.getItemDetail(params.id!);
      const cartLine = {
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity: Number(formData.get("quantity") ?? 0),
      };

      if (!actor) {
        const anonymousCartId = ensureAnonymousCartId(request);
        await checkoutApi.addGuestCartLine(anonymousCartId, cartLine);
        const response = redirect("/account/cart");
        appendAnonymousCartCookie(response.headers, anonymousCartId);
        return response;
      }

      await checkoutApi.addCartLine(cartLine);

      return redirect("/account/cart");
    }

    if (intent === "buy-now") {
      const actor = await resolveActorFromAuthApi({ request });
      const item = await discoveryApi.getItemDetail(params.id!);
      const source = {
        type: "buy-now",
        listingId: String(formData.get("listingId") ?? ""),
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity: Number(formData.get("quantity") ?? 0),
      } as const;

      if (!actor) {
        const query = new URLSearchParams({
          source: "buy-now",
          listingId: source.listingId,
          catalogItemId: source.catalogItemId,
          productId: source.productId,
          itemTitle: source.itemTitle,
          itemSubtitle: source.itemSubtitle ?? "",
          selectedOptions: JSON.stringify(source.selectedOptions),
          productSummary: source.productSummary ?? "",
          quantity: String(source.quantity),
        });
        return redirect(`/checkout/start?${query.toString()}`);
      }

      const session = await checkoutApi.createCheckoutSession({
        source,
      });

      return redirect(`/checkout/${session.session_id}`);
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
              const renderBuyActions = (formId: string) => (
                <Stack gap={2}>
                  <Button
                    form={formId}
                    type="submit"
                    name="intent"
                    value="buy-now"
                    disabled={!context.selectedProductId || !context.selectedListing}
                    block
                  >
                    {t("discovery.routes.itemDetail.buy.now.2")}</Button>
                  <Button
                    form={formId}
                    type="submit"
                    name="intent"
                    value="add-to-cart"
                    tone="secondary"
                    disabled={!context.selectedProductId}
                    block
                  >
                    {t("discovery.routes.itemDetail.add.to.cart.2")}</Button>
                </Stack>
              );
              const renderOfferActions = (formId: string) => (
                <Button
                  form={formId}
                  type="submit"
                  tone="secondary"
                  disabled={!context.selectedProductId}
                  block
                >
                  {t("discovery.routes.itemDetail.submit.offer.2")}</Button>
              );
              const renderOfferMatchActions = (formId: string) => (
                <Stack gap={2}>
                  <Button
                    form={formId}
                    type="submit"
                    name="intent"
                    value="sell-now"
                    disabled={!context.selectedAccountOfferMatch?.can_fulfill}
                    block
                  >
                    {t("discovery.routes.itemDetail.sell.now.2")}</Button>
                  <Button
                    form={formId}
                    type="submit"
                    name="intent"
                    value="add-to-sell-list"
                    tone="secondary"
                    disabled={
                      !context.selectedAccountOfferMatch?.can_fulfill ||
                      context.selectedAccountOfferMatch.in_sell_list
                    }
                    block
                  >
                    {context.selectedAccountOfferMatch?.in_sell_list
                      ? t("discovery.routes.itemDetail.in.sell.list.2")
                      : t("discovery.routes.itemDetail.add.to.sell.list.2")}
                  </Button>
                </Stack>
              );
              const renderListingActions = (formId: string) => {
                const hasMatchingInventory = context.selectedProductId
                  ? data.sellerInventoryItems.some(
                      (inventoryItem) => inventoryItem.product_id === context.selectedProductId,
                    )
                  : false;

                return (
                  <Button
                    form={formId}
                    type="submit"
                    name="intent"
                    value="list-at-price"
                    disabled={
                      !context.selectedProductId ||
                      (!ownListing && !hasMatchingInventory)
                    }
                    block
                  >
                    {ownListing ? t("discovery.routes.itemDetail.update.listing.2") : t("discovery.routes.itemDetail.list.at.price.3")}
                  </Button>
                );
              };
              const renderBuy = (
                formId: string,
                panelVariant: FormPanelVariant = "card",
                actions?: ReactNode,
              ) => (
                <CheckoutPurchaseIntentSection
                  formId={formId}
                  panelVariant={panelVariant}
                  actions={actions}
                  catalogItemId={context.itemId}
                  productId={context.selectedProductId}
                  selectedListing={context.selectedListing}
                  itemTitle={context.itemTitle}
                  selectedOptions={context.selectedProductOptions}
                  productSummary={context.selectedProductSummary}
                  visibleListingCount={context.visibleListings.length}
                  errorMessage={actionData?.error ?? null}
                />
              );
              const renderOffer = (
                formId: string,
                panelVariant: FormPanelVariant = "card",
                actions?: ReactNode,
              ) => (
                <MarketplaceOfferSubmissionSection
                  formId={formId}
                  panelVariant={panelVariant}
                  actions={actions}
                  catalogItemId={context.itemId}
                  productId={context.selectedProductId}
                  itemTitle={context.itemTitle}
                  selectedOptions={context.selectedProductOptions}
                  productSummary={context.selectedProductSummary}
                  visibleListingCount={context.visibleListings.length}
                  errorMessage={actionData?.error ?? null}
                />
              );
              const renderOfferMatch = (
                formId: string,
                panelVariant: FormPanelVariant = "card",
                actions?: ReactNode,
              ) => (
                <MarketplaceOfferMatchSection
                  formId={formId}
                  panelVariant={panelVariant}
                  actions={actions}
                  selectedOffer={context.selectedAccountOfferMatch}
                  productId={context.selectedProductId}
                  matchingOfferCount={context.visibleAccountOfferMatches.length}
                  errorMessage={actionData?.error ?? null}
                />
              );
              const renderListingSubmission = (
                formId: string,
                panelVariant: FormPanelVariant = "card",
                actions?: ReactNode,
              ) => (
                <MarketplaceListingSubmissionSection
                  formId={formId}
                  panelVariant={panelVariant}
                  actions={actions}
                  productId={context.selectedProductId}
                  productSummary={context.selectedProductSummary}
                  bestListing={context.bestListing}
                  ownListing={ownListing}
                  inventoryItems={data.sellerInventoryItems}
                  errorMessage={actionData?.error ?? null}
                />
              );
              const renderSellerRegistration = (
                panelVariant: FormPanelVariant = "card",
              ) => (
                <MarketplaceSellerRegistrationSection
                  panelVariant={panelVariant}
                  productSummary={context.selectedProductSummary}
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
                  buy: renderBuy("buy-box"),
                  offer: renderOffer("make-offer"),
                  sell: data.showSellerTab ? renderSeller("sell") : undefined,
                  mobile: {
                    buy: {
                      content: renderBuy("mobile-buy-box", "plain", null),
                      footer: renderBuyActions("mobile-buy-box"),
                    },
                    offer: {
                      content: renderOffer("mobile-make-offer", "plain", null),
                      footer: renderOfferActions("mobile-make-offer"),
                    },
                    sell: data.canUseSellerFeatures
                      ? {
                          content: renderOfferMatch("mobile-sell-box", "plain", null),
                          footer: renderOfferMatchActions("mobile-sell-box"),
                          title: t("discovery.routes.itemDetail.accept.offer.2"),
                        }
                      : {
                          content: renderSellerRegistration("plain"),
                          title: t("discovery.routes.itemDetail.sell.on.chase.sets.2"),
                        },
                    list: data.canUseSellerFeatures
                      ? {
                          content: renderListingSubmission("mobile-list-box", "plain", null),
                          footer: renderListingActions("mobile-list-box"),
                          title: ownListing ? t("discovery.routes.itemDetail.update.listing.3") : t("discovery.routes.itemDetail.list.at.price.4"),
                        }
                      : undefined,
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
