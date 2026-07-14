import { createHash } from "node:crypto";
import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { requireActorFromAuthApi, resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  navigateAfterWriteFromSourcesWithPlatformPostWriteToken,
  navigateAfterWriteWithPlatformPostWriteToken,
} from "@chase-sets/platform-runtime/post-write-tokens";
import { appendFreshWriteToken, type PostWriteHandoff } from "@chase-sets/http/responses";
import { createDiscoveryRequestApiClient } from "../../request-support/api-client";
import {
  appendAnonymousProductAlertCookie,
  ensureAnonymousProductAlertOwnerId,
} from "../../request-support/anonymous-product-alert";
import { imageVariantSrcSet } from "../../client-support/assets";
import {
  appendAnonymousListingDraftCookie,
  createMarketplaceRequestApiClient,
  ensureAnonymousListingDraftOwnerId,
} from "@chase-sets/marketplace/server";
import { createInventoryRequestApiClient } from "@chase-sets/inventory/server";
import {
  appendAnonymousCartCookie,
  ACCOUNT_CART_ADD_LINE_HANDOFF,
  ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
  appendAnonymousSellListCookie,
  createCheckoutRequestApiClient,
  ensureAnonymousCartId,
  ensureAnonymousSellListId,
} from "@chase-sets/checkout/server";
import type { AddToCartActionData } from "../../../features/item-detail/ui/commerce-sections";
import { canUseAccountCheckoutCart } from "../../../features/item-detail/ui/commerce-sections";
import {
  buildRegisterToClaimListingDraftHref,
  buildRegisterToClaimProductAlertHref,
  canUseAccountSellList,
  LISTING_STOCK_LOCATION_DESCRIPTION,
  LISTING_STOCK_LOCATION_NAME,
  LISTING_STOCK_SHIP_FROM_CODE,
  selectItemImage,
} from "./support";
import { sortListingsByBuyerPrice } from "../../../features/item-detail/domain/item-detail-market";
import {
  assertSelectedListingQuantityAvailable,
  findSelectedListingForAction,
  getPublicSelectedOfferForSellList,
  getListingAvailableQuantity,
  normalizeMoneyAmount,
  parsePositiveQuantity,
  parseSelectedOptions,
  saveGuestSelectedOfferToSellList,
  selectedOfferSellListLineFromPublicOffer,
  shipFromAddressFromForm,
} from "./action-helpers";
import type { DiscoveryItemDetail } from "../../client-support/contracts";
import type { SavedListProductSelection } from "@chase-sets/collections/server";
import {
  commitSavedListAddition,
  prepareSavedListAddition,
  savedListActionError,
} from "../../request-support/saved-list-addition";

type ListingCommandResult = {
  id?: string;
  listingId?: string;
  listing_id?: string;
  feeQuoteFingerprint?: string;
  fee_quote_fingerprint?: string;
};

const ITEM_DETAIL_LISTING_PUBLISH_HANDOFF = {
  kind: "marketplace.listing.publish",
  expectation: "resource-present",
  surface: "item-detail",
} as const satisfies PostWriteHandoff;

const ITEM_DETAIL_LISTING_UPDATE_HANDOFF = {
  kind: "marketplace.listing.update",
  expectation: "resource-updated",
  surface: "item-detail",
} as const satisfies PostWriteHandoff;

function listingCommandId(result: ListingCommandResult) {
  return result.id ?? result.listingId ?? result.listing_id ?? null;
}

function buyNowEntryAttemptKey(params: {
  accountId: string;
  source: Readonly<{
    listingId: string;
    catalogItemId: string;
    productId: string;
    selectedOptions: unknown;
    quantity: number;
    fulfillmentMode: string;
    lockedListingId: string | null;
  }>;
}) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        schema: "discovery.item-detail.buy-now-entry.v1",
        accountId: params.accountId,
        listingId: params.source.listingId,
        catalogItemId: params.source.catalogItemId,
        productId: params.source.productId,
        selectedOptions: params.source.selectedOptions,
        quantity: params.source.quantity,
        fulfillmentMode: params.source.fulfillmentMode,
        lockedListingId: params.source.lockedListingId,
      }),
    )
    .digest("hex")
    .slice(0, 32);

  return `chkentry_${digest}`;
}

function listingFeeQuoteFingerprint(result: ListingCommandResult) {
  return result.feeQuoteFingerprint ?? result.fee_quote_fingerprint ?? null;
}

function itemDetailSellListingPath(item: DiscoveryItemDetail, fallbackId: string, listingId: string | null) {
  const url = new URL(`/items/${item.slug || item.catalog_item_id || fallbackId}`, "https://chase-sets.local");
  url.searchParams.set("market", "sell");

  if (listingId) {
    url.searchParams.set("listing", listingId);
  }

  return `${url.pathname}${url.search}`;
}

function selectedListingSnapshotFromListing(listing: DiscoveryItemDetail["market_listings"][number] | null) {
  if (!listing) {
    return null;
  }

  return {
    listingId: listing.listing_id,
    sellerAccountId: listing.account_id,
    sellerDisplayName: listing.seller_display_name,
    sellerSlug: listing.seller_slug ?? null,
    priceAmount: listing.price_amount,
    source: "discovery.item-detail.add-to-cart",
  };
}

function findBestAvailableListingForAction(item: DiscoveryItemDetail, productId: string) {
  const bestListing =
    sortListingsByBuyerPrice(
      item.market_listings.filter(
        (listing) =>
          listing.product_id === productId && listing.status === "active" && getListingAvailableQuantity(listing) > 0,
      ),
    )[0] ?? null;

  if (!bestListing) {
    throw new Error(t("discovery.routes.itemDetail.validation.selected.listing.unavailable"));
  }

  return bestListing;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const discoveryApi = createDiscoveryRequestApiClient(request);
  if (intent === "commit-saved-list") {
    return commitSavedListAddition(request, formData);
  }
  if (intent === "prepare-saved-list") {
    try {
      const item = await discoveryApi.getItemDetail(params.id!);
      return prepareSavedListAddition({
        request,
        product: {
          catalogItemId: item.catalog_item_id as SavedListProductSelection["catalogItemId"],
          productId: String(formData.get("productId") ?? "") as SavedListProductSelection["productId"],
          selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        },
        productLabel:
          String(formData.get("productLabel") ?? "").trim() || [item.title, item.subtitle].filter(Boolean).join(" · "),
        sourceSurface: "item-detail",
      });
    } catch (error) {
      return savedListActionError(error);
    }
  }
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const inventoryApi = createInventoryRequestApiClient(request);
  const checkoutApi = createCheckoutRequestApiClient(request);

  try {
    if (intent === "create-product-alert") {
      const item = await discoveryApi.getItemDetail(params.id!);
      const body = {
        marketSide: String(formData.get("marketSide") ?? "") === "offer" ? "offer" : "listing",
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        thresholdAmount: normalizeMoneyAmount(formData.get("thresholdAmount"), {
          allowZero: true,
          optional: true,
          invalidMessage: t("discovery.routes.itemDetail.validation.threshold.invalid"),
        }),
      } as const;

      const actor = await resolveActorFromAuthApi({ request });
      if (!actor) {
        const anonymousOwnerId = ensureAnonymousProductAlertOwnerId(request);
        const productAlertIntent = await discoveryApi.createAnonymousProductAlertIntent(anonymousOwnerId, {
          ...body,
          sourcePath: `/items/${item.slug || item.catalog_item_id}?market=watch`,
        });
        const response = redirect(
          buildRegisterToClaimProductAlertHref(item.slug || item.catalog_item_id, productAlertIntent.intent_id),
        );
        appendAnonymousProductAlertCookie(response.headers, anonymousOwnerId, request);
        return response;
      }

      await requireActorFromAuthApi({
        request,
        permission: "accounts.view",
      });
      const result = await discoveryApi.createProductAlert(body);

      return redirect(
        appendFreshWriteToken(`/items/${item.slug || item.catalog_item_id}?productAlertCreated=1`, result),
      );
    }

    if (intent === "submit-offer") {
      const item = await discoveryApi.getItemDetail(params.id!);
      const offerPriceAmount = normalizeMoneyAmount(formData.get("priceAmount"), {
        invalidMessage: t("discovery.routes.itemDetail.validation.price.required"),
      });
      const quantity = parsePositiveQuantity(formData.get("quantityRequested"));
      const query = new URLSearchParams({
        source: "offer-intent",
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle ?? "",
        selectedOptions: String(formData.get("selectedOptions") ?? "[]"),
        productSummary: String(formData.get("productSummary") ?? ""),
        offerPriceAmount,
        quantity: String(quantity),
      });

      return redirect(`/checkout/buy/readiness?${query.toString()}`);
    }

    if (intent === "add-to-cart" || intent === "buy-best-match") {
      const actor = await resolveActorFromAuthApi({ request });
      const item = await discoveryApi.getItemDetail(params.id!);
      const itemImage = selectItemImage(item, "thumbnail");
      const quantity = parsePositiveQuantity(formData.get("quantity"));
      const productId = String(formData.get("productId") ?? "");
      const sellerPreferenceId =
        intent === "buy-best-match" ? "" : String(formData.get("sellerPreferenceId") ?? "").trim();
      const preferredListing = sellerPreferenceId ? findSelectedListingForAction(item, sellerPreferenceId) : null;
      if (intent === "buy-best-match") {
        assertSelectedListingQuantityAvailable(findBestAvailableListingForAction(item, productId), quantity);
      }
      if (preferredListing) {
        if (preferredListing.product_id !== productId) {
          throw new Error(t("discovery.routes.itemDetail.validation.selected.listing.unavailable"));
        }
        assertSelectedListingQuantityAvailable(preferredListing, quantity);
      }
      const lockedListingId = preferredListing?.listing_id ?? null;
      const cartLine = {
        catalogItemId: item.catalog_item_id,
        productId,
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        itemImageUrl: itemImage.src,
        itemImageSrcSet: itemImage.srcSet,
        itemImageLoadingUrl: item.image_fallback?.url ?? null,
        itemImageLoadingAlt: item.image_fallback?.alt ?? null,
        itemImageLoadingSrcSet: imageVariantSrcSet(item.image_fallback, "thumbnail") ?? null,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity,
        fulfillmentMode: lockedListingId ? ("locked-listing" as const) : ("optimize" as const),
        lockedListingId,
        sellerPreferenceId: lockedListingId,
        selectedListingSnapshot: selectedListingSnapshotFromListing(preferredListing),
      };

      if (!canUseAccountCheckoutCart(actor)) {
        const anonymousCartId = ensureAnonymousCartId(request);
        const result = await checkoutApi.addGuestCartLine(anonymousCartId, cartLine);
        if (intent === "buy-best-match") {
          const response = redirect(
            await navigateAfterWriteWithPlatformPostWriteToken(result, "/account/cart", {
              handoff: ACCOUNT_CART_ADD_LINE_HANDOFF,
            }),
          );
          appendAnonymousCartCookie(response.headers, anonymousCartId, request);
          return response;
        }

        const response = Response.json({
          status: "added-to-cart",
          itemTitle: item.title,
          quantity: cartLine.quantity,
          cartLine: checkoutCommandSnapshot(result),
          viewCartHref: await navigateAfterWriteWithPlatformPostWriteToken(result, "/account/cart", {
            handoff: ACCOUNT_CART_ADD_LINE_HANDOFF,
          }),
        } satisfies AddToCartActionData);
        appendAnonymousCartCookie(response.headers, anonymousCartId, request);
        return response;
      }

      const result = await checkoutApi.addCartLine(cartLine);
      if (intent === "buy-best-match") {
        return redirect(
          await navigateAfterWriteWithPlatformPostWriteToken(result, "/account/cart", {
            handoff: ACCOUNT_CART_ADD_LINE_HANDOFF,
          }),
        );
      }

      return Response.json({
        status: "added-to-cart",
        itemTitle: item.title,
        quantity: cartLine.quantity,
        cartLine: checkoutCommandSnapshot(result),
        viewCartHref: await navigateAfterWriteWithPlatformPostWriteToken(result, "/account/cart", {
          handoff: ACCOUNT_CART_ADD_LINE_HANDOFF,
        }),
      } satisfies AddToCartActionData);
    }

    if (intent === "buy-this-listing") {
      const actor = await resolveActorFromAuthApi({ request });
      const item = await discoveryApi.getItemDetail(params.id!);
      const productId = String(formData.get("productId") ?? "");
      const lockedListingId = String(formData.get("lockedListingId") ?? formData.get("listingId") ?? "").trim();
      const quantity = parsePositiveQuantity(formData.get("quantity"));
      const lockedListing = lockedListingId
        ? findSelectedListingForAction(item, lockedListingId)
        : findBestAvailableListingForAction(item, productId);
      assertSelectedListingQuantityAvailable(lockedListing, quantity);
      const lockedListingAvailableQuantity = lockedListing ? getListingAvailableQuantity(lockedListing) : 0;
      const source = {
        type: "buy-now",
        listingId: lockedListing.listing_id,
        catalogItemId: item.catalog_item_id,
        productId,
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity,
        fulfillmentMode: "locked-listing" as const,
        lockedListingId: lockedListing.listing_id,
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
          priceAmount: lockedListing?.price_amount ?? "",
          sellerName: lockedListing?.seller_display_name ?? "",
          availability: lockedListing
            ? t("discovery.routes.itemDetail.inventory.option.label", {
                productSummary: source.productSummary ?? source.itemTitle,
                availableQuantity: lockedListingAvailableQuantity,
              })
            : "",
          fulfillment: t("discovery.routes.itemDetail.confirmed.at.checkout"),
        });
        return redirect(`/checkout/buy/readiness?${query.toString()}`);
      }

      const session = await checkoutApi.createCheckoutSession({
        entryAttemptKey: buyNowEntryAttemptKey({
          accountId: String(actor?.accountId ?? ""),
          source,
        }),
        source,
      });

      return redirect(
        await navigateAfterWriteWithPlatformPostWriteToken(session, `/checkout/buy/session/${session.session_id}`),
      );
    }

    if (intent === "sell-now") {
      const actor = await resolveActorFromAuthApi({ request });
      const item = await discoveryApi.getItemDetail(params.id!);
      const offerId = String(formData.get("offerId") ?? "").trim();

      if (!canUseAccountSellList(actor)) {
        return saveGuestSelectedOfferToSellList(request, checkoutApi, item, offerId);
      }

      await requireActorFromAuthApi({
        request,
        permission: "offers.manage",
      });

      const offer = getPublicSelectedOfferForSellList(item, offerId);
      const result = await checkoutApi.addSellListLine(selectedOfferSellListLineFromPublicOffer(item, offer));
      return redirect(
        await navigateAfterWriteWithPlatformPostWriteToken(result, "/account/sell-list", {
          handoff: ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
        }),
      );
    }

    if (intent === "add-to-sell-list") {
      const actor = await resolveActorFromAuthApi({ request });

      const item = await discoveryApi.getItemDetail(params.id!);
      const offerId = String(formData.get("offerId") ?? "").trim();

      if (!canUseAccountSellList(actor)) {
        return saveGuestSelectedOfferToSellList(request, checkoutApi, item, offerId);
      }

      await requireActorFromAuthApi({
        request,
        permission: "offers.manage",
      });

      const offer = getPublicSelectedOfferForSellList(item, offerId);
      const result = await checkoutApi.addSellListLine(selectedOfferSellListLineFromPublicOffer(item, offer));
      return redirect(
        await navigateAfterWriteWithPlatformPostWriteToken(result, "/account/sell-list", {
          handoff: ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
        }),
      );
    }

    if (intent === "add-product-to-sell-list") {
      const actor = await resolveActorFromAuthApi({ request });

      const item = await discoveryApi.getItemDetail(params.id!);
      const quantity = parsePositiveQuantity(formData.get("quantity"));
      const sellListLine = {
        lineType: "product",
        offerId: null,
        buyerAccountId: null,
        buyerDisplayName: null,
        offerPriceAmount: null,
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity,
        fallbackMode: "none",
        minimumListingPriceAmount: null,
      } as const;

      if (!canUseAccountSellList(actor)) {
        const anonymousSellListId = ensureAnonymousSellListId(request);
        const result = await checkoutApi.addGuestSellListLine(anonymousSellListId, sellListLine);
        const response = redirect(
          await navigateAfterWriteWithPlatformPostWriteToken(result, "/account/sell-list", {
            handoff: ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
          }),
        );
        appendAnonymousSellListCookie(response.headers, anonymousSellListId, request);
        return response;
      }

      const result = await checkoutApi.addSellListLine(sellListLine);
      return redirect(
        await navigateAfterWriteWithPlatformPostWriteToken(result, "/account/sell-list", {
          handoff: ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
        }),
      );
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

      const result = await inventoryApi.createStorageLocation({
        name: LISTING_STOCK_LOCATION_NAME,
        description: LISTING_STOCK_LOCATION_DESCRIPTION,
        shipFromCode: LISTING_STOCK_SHIP_FROM_CODE,
        shipFromAddress,
      });

      return redirect(appendFreshWriteToken(`/items/${item.slug || item.catalog_item_id}?market=sell`, result));
    }

    if (intent === "list-at-price") {
      const item = await discoveryApi.getItemDetail(params.id!);

      const listingId = String(formData.get("listingId") ?? "").trim();
      const priceAmount = normalizeMoneyAmount(formData.get("priceAmount"), {
        invalidMessage: t("discovery.routes.itemDetail.validation.price.required"),
      });
      const quantityCap = parsePositiveQuantity(formData.get("quantityCap"));

      if (listingId) {
        await requireActorFromAuthApi({
          request,
          permission: "listings.manage",
        });
        const quote = await marketplaceApi.previewListingTerms({ priceAmount });
        const priceResult = await marketplaceApi.updateListingPrice(listingId, {
          priceAmount,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        });
        const result = await marketplaceApi.updateListingQuantityCap(listingId, {
          quantityCap,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        });
        return redirect(
          await navigateAfterWriteFromSourcesWithPlatformPostWriteToken(
            [priceResult, result],
            itemDetailSellListingPath(item, params.id!, listingId),
            { handoff: ITEM_DETAIL_LISTING_UPDATE_HANDOFF },
          ),
        );
      }

      const inventoryItemId = String(formData.get("inventoryItemId") ?? "").trim();
      const selectedOptions = parseSelectedOptions(formData.get("selectedOptions"));
      const productId = String(formData.get("productId") ?? "").trim();
      const productSummary = String(formData.get("productSummary") ?? "").trim() || null;
      const actor = await resolveActorFromAuthApi({ request });

      if (!canUseAccountSellList(actor)) {
        const anonymousListingDraftOwnerId = ensureAnonymousListingDraftOwnerId(request);
        const draft = await marketplaceApi.createAnonymousListingDraftIntent(anonymousListingDraftOwnerId, {
          sourcePath: `/items/${item.slug || item.catalog_item_id}?market=sell`,
          catalogItemId: item.catalog_item_id,
          productId,
          selectedOptions,
          productSummary,
          priceAmount,
          quantityCap,
        });
        const response = redirect(buildRegisterToClaimListingDraftHref(draft.intent_id));
        appendAnonymousListingDraftCookie(response.headers, anonymousListingDraftOwnerId, request);
        return response;
      }

      await requireActorFromAuthApi({
        request,
        permission: "listings.manage",
      });
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
                selectedOptions,
                quantity: quantityCap,
              })
            ).snapshot,
          };
      const result = (await marketplaceApi.createListing(listingBody)) as ListingCommandResult;
      const createdListingId = listingCommandId(result);
      const writeResults: unknown[] = [result];

      if (createdListingId) {
        writeResults.push(
          await marketplaceApi.publishListing(createdListingId, {
            feeQuoteFingerprint: listingFeeQuoteFingerprint(result),
          }),
        );
      } else {
        throw new Error(t("discovery.routes.itemDetail.validation.selected.listing.unavailable"));
      }

      return redirect(
        await navigateAfterWriteFromSourcesWithPlatformPostWriteToken(
          writeResults,
          itemDetailSellListingPath(item, params.id!, createdListingId),
          { handoff: ITEM_DETAIL_LISTING_PUBLISH_HANDOFF },
        ),
      );
    }

    return null;
  } catch (error) {
    if (error instanceof Error) {
      return {
        error: error.message,
        intent,
      };
    }

    throw error;
  }
}

function checkoutCommandSnapshot(result: Readonly<{ id: string; version: number; status: string }>) {
  return {
    id: result.id,
    version: result.version,
    status: result.status,
  };
}
