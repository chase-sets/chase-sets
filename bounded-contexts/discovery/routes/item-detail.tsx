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
  Card,
  CurrencyInput,
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
import {
  createDiscoveryRequestApiClient,
  DiscoveryApiError,
} from "../support/request-support/api-client";
import type {
  DiscoveryMarketListing,
  DiscoverySellerInventoryRecord,
  DiscoverySellerOffer,
} from "../support/client-support/contracts";
import { discoveryAssetUrls } from "../support/client-support/assets";
import {
  createMarketplaceRequestApiClient,
  type MarketplaceListingInventoryRecordOption,
} from "@chase-sets/marketplace/server";
import { createOrderingRequestApiClient } from "@chase-sets/ordering/server";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";

const MARKETPLACE_DESCRIPTION =
  "Browse the Chase Sets marketplace with server-rendered discovery results and item detail pages.";

const EMPTY_ITEM_DETAIL_RESULT = {
  item: null,
  sellerOffers: [],
  sellerInventoryRecords: [],
  sellerAccountId: null,
  showSellerOffers: false,
  showSellerTab: true,
  canUseSellerFeatures: false,
  registerToSellHref: "/register",
  notFound: false,
  error: null,
} as const;

function buildRegisterToSellHref(request: Request) {
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;

  return `/register?returnTo=${encodeURIComponent(returnTo)}`;
}

function toSellerInventoryRecord(
  record: MarketplaceListingInventoryRecordOption,
): DiscoverySellerInventoryRecord {
  return {
    record_id: record.record_id,
    catalog_catalog_item_id: record.catalog_catalog_item_id,
    product_id: record.product_id,
    item_title: record.item_title,
    item_subtitle: record.item_subtitle,
    selected_options: record.selected_options,
    product_summary: record.product_summary,
    storage_location_name: record.storage_location_name,
    ship_from_code: record.ship_from_code,
    available_quantity: record.available_quantity,
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
  catalogItemId,
  productId,
  itemTitle,
  selectedOptions,
  productSummary,
  visibleListingCount,
  errorMessage,
}: {
  formId?: string;
  catalogItemId: string;
  productId: string | null;
  itemTitle: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  visibleListingCount: number;
  errorMessage?: string | null;
}) {
  return (
    <Card>
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
          <Stack gap={1}>
            <Text weight="semibold">Make an offer</Text>
            <Text size="sm" tone="secondary">
              {productSummary ? `Offer for: ${productSummary}` : itemTitle}
            </Text>
            <Text size="sm" tone="secondary">
              {productId
                ? `${visibleListingCount} listing${visibleListingCount === 1 ? "" : "s"} match this selection.`
                : "Choose options to make an offer."}
            </Text>
          </Stack>
          {errorMessage ? <Text>{errorMessage}</Text> : null}
          <CurrencyInput
            label="Offer price"
            name="priceAmount"
            placeholder="24.99"
            min="0"
            step="0.01"
            required
          />
          <NumberInput label="Quantity requested" name="quantityRequested" min="1" required />
          <Button type="submit" tone="secondary" disabled={!productId} block>
            Submit offer
          </Button>
        </Stack>
      </form>
    </Card>
  );
}

function OrderingAddToCartSection({
  formId = "buy-box",
  catalogItemId,
  productId,
  bestListing,
  itemTitle,
  selectedOptions,
  productSummary,
  visibleListingCount,
  errorMessage,
}: {
  formId?: string;
  catalogItemId: string;
  productId: string | null;
  bestListing: { listing_id: string; price_amount: string; seller_display_name: string | null; visible_quantity: number } | null;
  itemTitle: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  visibleListingCount: number;
  errorMessage?: string | null;
}) {
  return (
    <Card glow={visibleListingCount > 0}>
      <form id={formId} method="post">
        <Stack gap={3}>
          <input type="hidden" name="catalogItemId" value={catalogItemId} />
          <input type="hidden" name="productId" value={productId ?? ""} />
          <input
            type="hidden"
            name="selectedOptions"
            value={JSON.stringify(selectedOptions)}
          />
          <input type="hidden" name="productSummary" value={productSummary ?? ""} />
          {bestListing ? (
            <input type="hidden" name="listingId" value={bestListing.listing_id} />
          ) : null}
          <Stack gap={1}>
            <Text weight="semibold">Buy selected product</Text>
            <Text size="sm" tone="secondary">
              {productSummary ? `Buying: ${productSummary}` : itemTitle}
            </Text>
            {bestListing ? (
              <Text size="sm" tone="secondary">
                Best listing: ${bestListing.price_amount} from{" "}
                {bestListing.seller_display_name ?? "Seller"}.
              </Text>
            ) : null}
            <Text size="sm" tone="secondary">
              {productId
                ? `${visibleListingCount} listing${visibleListingCount === 1 ? "" : "s"} match this selection.`
                : "Choose options to add this product to your cart."}
            </Text>
            {productId && visibleListingCount === 0 ? (
              <Text size="sm" tone="secondary">
                Add to cart saves buyer intent; checkout matches exact inventory when supply is available.
              </Text>
            ) : null}
          </Stack>
          {errorMessage ? <Text>{errorMessage}</Text> : null}
          <NumberInput
            label="Quantity"
            name="quantity"
            min="1"
            defaultValue="1"
            required
          />
          <NativeSelect
            label="Shipping"
            name="shippingOption"
            defaultValue="standard"
            items={[
              { value: "standard", label: "Standard insured" },
              { value: "expedited", label: "Expedited" },
              { value: "priority", label: "Priority signature" },
            ]}
          />
          <Button
            type="submit"
            name="intent"
            value="buy-now"
            disabled={!productId || !bestListing}
            block
          >
            Buy now
          </Button>
          <Button
            type="submit"
            name="intent"
            value="add-to-cart"
            tone="secondary"
            disabled={!productId}
            block
          >
            Add to cart
          </Button>
        </Stack>
      </form>
    </Card>
  );
}

function MarketplaceSellerOfferSection({
  formId = "sell-box",
  bestOffer,
  productId,
  matchingOfferCount,
  errorMessage,
}: {
  formId?: string;
  bestOffer: {
    offer_id: string;
    buyer_display_name: string | null;
    buyer_account_id: string;
    price_amount: string;
    quantity_requested: number;
    seller_available_quantity: number;
    can_fulfill: boolean;
    in_sell_list: boolean;
  } | null;
  productId: string | null;
  matchingOfferCount: number;
  errorMessage?: string | null;
}) {
  return (
    <Card glow={Boolean(bestOffer?.can_fulfill)}>
      <form id={formId} method="post">
        <Stack gap={3}>
          <input type="hidden" name="offerId" value={bestOffer?.offer_id ?? ""} />
          <Stack gap={1}>
            <Text weight="semibold">Sell to buyer offer</Text>
            {bestOffer ? (
              <>
                <Text size="sm" tone="secondary">
                  Best offer: ${bestOffer.price_amount} from{" "}
                  {bestOffer.buyer_display_name ?? bestOffer.buyer_account_id}.
                </Text>
                <Text size="sm" tone="secondary">
                  Requested {bestOffer.quantity_requested}; your active supply covers{" "}
                  {bestOffer.seller_available_quantity}.
                </Text>
                <Badge tone={bestOffer.can_fulfill ? "success" : "warning"}>
                  {bestOffer.can_fulfill ? "Can fulfill" : "Needs supply"}
                </Badge>
              </>
            ) : (
              <Text size="sm" tone="secondary">
                {!productId
                  ? "Choose options to review matching buyer offers."
                  : matchingOfferCount > 0
                    ? "Matching buyer offers need more active supply."
                    : "No buyer offers match this product yet."}
              </Text>
            )}
          </Stack>
          {errorMessage ? <Text>{errorMessage}</Text> : null}
          <Button
            type="submit"
            name="intent"
            value="sell-now"
            disabled={!bestOffer?.can_fulfill}
            block
          >
            Sell now
          </Button>
          <Button
            type="submit"
            name="intent"
            value="add-to-sell-list"
            tone="secondary"
            disabled={!bestOffer?.can_fulfill || bestOffer.in_sell_list}
            block
          >
            {bestOffer?.in_sell_list ? "In sell list" : "Add to sell list"}
          </Button>
        </Stack>
      </form>
    </Card>
  );
}

export function MarketplaceSellerRegistrationSection({
  productSummary,
  registerHref,
}: {
  productSummary: string | null;
  registerHref: string;
}) {
  return (
    <Card glow>
      <Stack gap={3}>
        <Stack gap={1}>
          <Text weight="semibold">Sell on Chase Sets</Text>
          <Text size="sm" tone="secondary">
            Register to apply as a seller, list inventory, and respond to buyer
            offers from the same marketplace view buyers use.
          </Text>
          {productSummary ? (
            <Text size="sm" tone="secondary">
              Start with: {productSummary}
            </Text>
          ) : (
            <Text size="sm" tone="secondary">
              Choose product options first, then register to apply with the item
              already in context.
            </Text>
          )}
        </Stack>
        <LinkButton href={registerHref} leadingIcon="plus" block>
          Register to sell
        </LinkButton>
      </Stack>
    </Card>
  );
}

function MarketplaceListingSubmissionSection({
  formId = "list-box",
  productId,
  productSummary,
  bestListing,
  ownListing,
  inventoryRecords,
  errorMessage,
}: {
  formId?: string;
  productId: string | null;
  productSummary: string | null;
  bestListing: {
    listing_id: string;
    inventory_record_id: string;
    product_id: string;
    price_amount: string;
    quantity_cap: number;
    status: string;
  } | null;
  ownListing: DiscoveryMarketListing | null;
  inventoryRecords: readonly DiscoverySellerInventoryRecord[];
  errorMessage?: string | null;
}) {
  const matchingInventory = productId
    ? inventoryRecords.filter((record) => record.product_id === productId)
    : [];
  const selectedInventory = matchingInventory[0] ?? null;
  const listing = ownListing ?? null;
  const availableQuantity = listing?.quantity_cap ?? selectedInventory?.available_quantity ?? 0;
  const defaultQuantity = Math.max(1, Math.min(availableQuantity, 1));

  return (
    <Card glow={Boolean(listing)}>
      <form id={formId} method="post">
        <Stack gap={3}>
          <input type="hidden" name="productId" value={productId ?? ""} />
          <input type="hidden" name="listingId" value={listing?.listing_id ?? ""} />
          <Stack gap={1}>
            <Text weight="semibold">
              {listing ? "Update your listing" : "List at price"}
            </Text>
            <Text size="sm" tone="secondary">
              {productSummary
                ? `Selling: ${productSummary}`
                : "Choose options to list matching inventory."}
            </Text>
            {listing ? (
              <Text size="sm" tone="secondary">
                Your {listing.status} listing is ${listing.price_amount}.
              </Text>
            ) : bestListing ? (
              <Text size="sm" tone="secondary">
                Current best listing is ${bestListing.price_amount}.
              </Text>
            ) : null}
          </Stack>
          {listing ? (
            <input
              type="hidden"
              name="inventoryRecordId"
              value={listing.inventory_record_id}
            />
          ) : (
            <NativeSelect
              label="Inventory"
              name="inventoryRecordId"
              defaultValue={selectedInventory?.record_id ?? ""}
              items={[
                { value: "", label: "Choose inventory" },
                ...matchingInventory.map((record) => ({
                  value: record.record_id,
                  label: `${record.product_summary ?? "Selected product"} - ${record.available_quantity} available`,
                })),
              ]}
              required
            />
          )}
          <CurrencyInput
            label="Listing price"
            name="priceAmount"
            defaultValue={listing?.price_amount ?? bestListing?.price_amount ?? ""}
            required
          />
          <NumberInput
            label="Quantity to list"
            name="quantityCap"
            min={1}
            max={Math.max(availableQuantity, 1)}
            defaultValue={String(listing?.quantity_cap ?? defaultQuantity)}
            required
          />
          {errorMessage ? <Text>{errorMessage}</Text> : null}
          <Button
            type="submit"
            name="intent"
            value="list-at-price"
            disabled={!productId || (!listing && matchingInventory.length === 0)}
            block
          >
            {listing ? "Update listing" : "List at price"}
          </Button>
        </Stack>
      </form>
    </Card>
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
            { value: "buy", label: "Buy" },
            { value: "sell", label: "Sell" },
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
      sellerOffers: [],
      sellerInventoryRecords: [],
      sellerAccountId: null,
      showSellerOffers: false,
      showSellerTab: false,
      canUseSellerFeatures: false,
      registerToSellHref: buildRegisterToSellHref(request),
      notFound: true,
    };
  }

  try {
    const item = await api.getItemDetail(id);
    const actor = await resolveActorFromAuthApi({ request });
    const canReviewSellerOffers = Boolean(
      actor?.permissions.includes("offers.view") &&
        actor.permissions.includes("listings.view"),
    );
    const canSellOnItem = Boolean(
      actor?.permissions.includes("listings.view") &&
        actor.permissions.includes("listings.manage"),
    );
    let sellerOffers: DiscoverySellerOffer[] = [];
    let sellerInventoryRecords: DiscoverySellerInventoryRecord[] = [];

    if (canReviewSellerOffers) {
      try {
        const result = await marketplaceApi.listSellerOffers("limit=100&offset=0");
        sellerOffers = result.items.filter(
          (offer) => offer.catalog_catalog_item_id === item.catalog_item_id,
        );
      } catch {
        sellerOffers = [];
      }
    }

    if (canSellOnItem) {
      try {
        const records = await marketplaceApi.listSellerListingInventory(
          `limit=100&offset=0&catalogItemId=${encodeURIComponent(item.catalog_item_id)}`,
        );
        sellerInventoryRecords = (records.items as MarketplaceListingInventoryRecordOption[])
          .map(toSellerInventoryRecord);
      } catch {
        sellerInventoryRecords = [];
      }
    }

    return {
      item,
      sellerOffers,
      sellerInventoryRecords,
      sellerAccountId: canSellOnItem ? actor?.accountId ?? null : null,
      showSellerOffers: canReviewSellerOffers || canSellOnItem,
      showSellerTab: true,
      canUseSellerFeatures: canReviewSellerOffers || canSellOnItem,
      registerToSellHref: buildRegisterToSellHref(request),
      notFound: false,
    };
  } catch (error) {
    if (error instanceof DiscoveryApiError) {
      return {
        item: null,
        sellerOffers: [],
        sellerInventoryRecords: [],
        sellerAccountId: null,
        showSellerOffers: false,
        showSellerTab: false,
        canUseSellerFeatures: false,
        registerToSellHref: buildRegisterToSellHref(request),
        notFound: true,
        error: error.message,
      };
    }

    return {
      item: null,
      sellerOffers: [],
      sellerInventoryRecords: [],
      sellerAccountId: null,
      showSellerOffers: false,
      showSellerTab: false,
      canUseSellerFeatures: false,
      registerToSellHref: buildRegisterToSellHref(request),
      notFound: true,
      error: error instanceof Error ? error.message : "Item not found.",
    };
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const discoveryApi = createDiscoveryRequestApiClient(request);
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const orderingApi = createOrderingRequestApiClient(request);

  try {
    if (intent === "submit-offer") {
      await requireActorFromAuthApi({
        request,
        permission: "offers.manage",
      });
      const item = await discoveryApi.getItemDetail(params.id!);

      await marketplaceApi.createBuyerOffer({
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        priceAmount: formData.get("priceAmount"),
        quantityRequested: Number(formData.get("quantityRequested") ?? 0),
      });

      return redirect("/account/offers");
    }

    if (intent === "add-to-cart") {
      await requireActorFromAuthApi({
        request,
        permission: "orders.manage",
      });
      const item = await discoveryApi.getItemDetail(params.id!);

      await orderingApi.addCartLine({
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity: Number(formData.get("quantity") ?? 0),
      });

      return redirect("/account/cart");
    }

    if (intent === "buy-now") {
      await requireActorFromAuthApi({
        request,
        permission: "orders.manage",
      });

      const result = await orderingApi.buyNow({
        listingId: String(formData.get("listingId") ?? ""),
        productId: String(formData.get("productId") ?? ""),
        quantity: Number(formData.get("quantity") ?? 0),
        shippingOption: String(formData.get("shippingOption") ?? "standard"),
      }) as { orderIds?: readonly string[] };

      return redirect(
        result.orderIds?.[0] ? `/account/orders/${result.orderIds[0]}` : "/account/orders",
      );
    }

    if (intent === "sell-now") {
      await requireActorFromAuthApi({
        request,
        permission: "offers.manage",
      });

      await marketplaceApi.acceptSellerOffer(String(formData.get("offerId") ?? ""));
      return redirect("/account/sales");
    }

    if (intent === "add-to-sell-list") {
      await requireActorFromAuthApi({
        request,
        permission: "offers.manage",
      });

      await marketplaceApi.addSellerOfferCartItem({
        offerId: String(formData.get("offerId") ?? ""),
      });
      return redirect("/account/market-offers");
    }

    if (intent === "list-at-price") {
      await requireActorFromAuthApi({
        request,
        permission: "listings.manage",
      });

      const listingId = String(formData.get("listingId") ?? "").trim();
      const priceAmount = String(formData.get("priceAmount") ?? "");
      const quantityCap = Number(formData.get("quantityCap") ?? 0);

      if (listingId) {
        await marketplaceApi.updateListingPrice(listingId, { priceAmount });
        await marketplaceApi.updateListingQuantityCap(listingId, { quantityCap });
        return redirect(`/items/${params.id}`);
      }

      const result = await marketplaceApi.createListing({
        inventoryRecordId: String(formData.get("inventoryRecordId") ?? ""),
        priceAmount,
        quantityCap,
      }) as { id?: string };

      if (result.id) {
        await marketplaceApi.publishListing(result.id);
      }

      return redirect(`/items/${params.id}`);
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

export const meta: MetaFunction<typeof loader> = ({ data }) =>
  buildOpenGraphMeta({
    title: data?.item
      ? `${data.item.title} | Marketplace`
      : "Item Not Found | Marketplace",
    description: data?.item?.description
      ? data.item.description
      : MARKETPLACE_DESCRIPTION,
    imageUrl: data?.item
      ? data.item.image_urls[0] ?? discoveryAssetUrls.defaultProductImage
      : undefined,
    type: data?.item ? "product" : "website",
  });

export default function DiscoveryItemDetailRoute() {
  const data = useLoaderData<typeof loader>() ?? EMPTY_ITEM_DETAIL_RESULT;
  const actionData = useActionData<typeof action>();

  return (
    <ItemDetailPage
      data={data.item}
      sellerOffers={data.sellerOffers}
      showSellerOffers={data.showSellerOffers}
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
              const renderBuy = (formId: string) => (
                <OrderingAddToCartSection
                  formId={formId}
                  catalogItemId={context.itemId}
                  productId={context.selectedProductId}
                  bestListing={context.bestListing}
                  itemTitle={context.itemTitle}
                  selectedOptions={context.selectedProductOptions}
                  productSummary={context.selectedProductSummary}
                  visibleListingCount={context.visibleListings.length}
                  errorMessage={actionData?.error ?? null}
                />
              );
              const renderOffer = (formId: string) => (
                <MarketplaceOfferSubmissionSection
                  formId={formId}
                  catalogItemId={context.itemId}
                  productId={context.selectedProductId}
                  itemTitle={context.itemTitle}
                  selectedOptions={context.selectedProductOptions}
                  productSummary={context.selectedProductSummary}
                  visibleListingCount={context.visibleListings.length}
                  errorMessage={actionData?.error ?? null}
                />
              );
              const renderSeller = (formIdPrefix: string) =>
                data.canUseSellerFeatures ? (
                  <Stack gap={4}>
                    <MarketplaceSellerOfferSection
                      formId={`${formIdPrefix}-sell-box`}
                      bestOffer={context.bestSellerOffer}
                      productId={context.selectedProductId}
                      matchingOfferCount={context.visibleSellerOffers.length}
                      errorMessage={actionData?.error ?? null}
                    />
                    <MarketplaceListingSubmissionSection
                      formId={`${formIdPrefix}-list-box`}
                      productId={context.selectedProductId}
                      productSummary={context.selectedProductSummary}
                      bestListing={context.bestListing}
                      ownListing={ownListing}
                      inventoryRecords={data.sellerInventoryRecords}
                      errorMessage={actionData?.error ?? null}
                    />
                  </Stack>
                ) : (
                  <MarketplaceSellerRegistrationSection
                    productSummary={context.selectedProductSummary}
                    registerHref={data.registerToSellHref}
                  />
                );
              const desktopBuyer = (
                <Stack gap={4}>
                  {renderBuy("buy-box")}
                  {renderOffer("make-offer")}
                </Stack>
              );
              const desktopSeller = renderSeller("desktop");

              return (
                {
                  desktop: (
                    <ItemCommercePanel
                      showSellerTab={data.showSellerTab}
                      buyer={desktopBuyer}
                      seller={desktopSeller}
                    />
                  ),
                  buy: renderBuy("mobile-buy-box"),
                  offer: renderOffer("mobile-make-offer"),
                  sell: data.showSellerTab ? renderSeller("mobile") : undefined,
                  sellLabel: data.canUseSellerFeatures ? "Sell" : "Sell",
                }
              );
            }
          : undefined
      }
    />
  );
}
