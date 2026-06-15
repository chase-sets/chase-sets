import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { requireActorFromAuthApi, resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
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
import {
  assertSelectedListingQuantityAvailable,
  findSelectedListingForAction,
  getFreshOfferMatchForAction,
  getListingAvailableQuantity,
  normalizeMoneyAmount,
  parsePositiveQuantity,
  parseSelectedOptions,
  saveGuestSelectedOfferToSellList,
  shipFromAddressFromForm,
} from "./action-helpers";

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const discoveryApi = createDiscoveryRequestApiClient(request);
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

    if (intent === "add-to-cart") {
      const actor = await resolveActorFromAuthApi({ request });
      const item = await discoveryApi.getItemDetail(params.id!);
      const itemImage = selectItemImage(item, "thumbnail");
      const quantity = parsePositiveQuantity(formData.get("quantity"));
      const productId = String(formData.get("productId") ?? "");
      const sellerPreferenceId = String(formData.get("sellerPreferenceId") ?? "").trim();
      const preferredListing = sellerPreferenceId ? findSelectedListingForAction(item, sellerPreferenceId) : null;
      if (preferredListing) {
        if (preferredListing.product_id !== productId) {
          throw new Error(t("discovery.routes.itemDetail.validation.selected.listing.unavailable"));
        }
        assertSelectedListingQuantityAvailable(preferredListing, quantity);
      }
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
        fulfillmentMode: "optimize" as const,
        lockedListingId: null,
        sellerPreferenceId: preferredListing?.listing_id ?? null,
      };

      if (!canUseAccountCheckoutCart(actor)) {
        const anonymousCartId = ensureAnonymousCartId(request);
        const result = await checkoutApi.addGuestCartLine(anonymousCartId, cartLine);
        const response = Response.json({
          status: "added-to-cart",
          itemTitle: item.title,
          quantity: cartLine.quantity,
          cartLine: checkoutCommandSnapshot(result),
        } satisfies AddToCartActionData);
        appendAnonymousCartCookie(response.headers, anonymousCartId);
        return response;
      }

      const result = await checkoutApi.addCartLine(cartLine);

      return Response.json({
        status: "added-to-cart",
        itemTitle: item.title,
        quantity: cartLine.quantity,
        cartLine: checkoutCommandSnapshot(result),
      } satisfies AddToCartActionData);
    }

    if (intent === "buy-now" || intent === "buy-this-listing") {
      const actor = await resolveActorFromAuthApi({ request });
      const item = await discoveryApi.getItemDetail(params.id!);
      const lockedListingId =
        intent === "buy-this-listing"
          ? String(formData.get("lockedListingId") ?? formData.get("listingId") ?? "").trim()
          : "";
      const quantity = parsePositiveQuantity(formData.get("quantity"));
      const lockedListing = lockedListingId ? findSelectedListingForAction(item, lockedListingId) : null;
      if (lockedListing) {
        assertSelectedListingQuantityAvailable(lockedListing, quantity);
      }
      const lockedListingAvailableQuantity = lockedListing ? getListingAvailableQuantity(lockedListing) : 0;
      const source = {
        type: "buy-now",
        listingId: lockedListingId,
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity,
        fulfillmentMode: lockedListingId ? ("locked-listing" as const) : ("optimize" as const),
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
        source,
      });

      return redirect(appendFreshWriteToken(`/checkout/buy/session/${session.session_id}`, session));
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

      await getFreshOfferMatchForAction(marketplaceApi, item, offerId);
      const result = await marketplaceApi.acceptOfferMatch(offerId, {
        feeQuoteFingerprint: String(formData.get("feeQuoteFingerprint") ?? ""),
      });
      return redirect(appendFreshWriteToken("/account/sales", result));
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

      const offer = await getFreshOfferMatchForAction(marketplaceApi, item, offerId);

      const result = await checkoutApi.addSellListLine({
        lineType: "selected-offer",
        offerId,
        buyerAccountId: offer.buyer_account_id,
        buyerDisplayName: offer.buyer_display_name,
        offerPriceAmount: offer.price_amount,
        catalogItemId: item.catalog_item_id,
        productId: offer.product_id,
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: offer.selected_options,
        productSummary: offer.product_summary,
        quantity: offer.quantity_requested,
      });
      return redirect(appendFreshWriteToken("/account/sell-list", result));
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
        const response = redirect(appendFreshWriteToken("/account/sell-list", result));
        appendAnonymousSellListCookie(response.headers, anonymousSellListId);
        return response;
      }

      const result = await checkoutApi.addSellListLine(sellListLine);
      return redirect(appendFreshWriteToken("/account/sell-list", result));
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
        await marketplaceApi.updateListingPrice(listingId, {
          priceAmount,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        });
        const result = await marketplaceApi.updateListingQuantityCap(listingId, {
          quantityCap,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        });
        return redirect(appendFreshWriteToken(`/items/${item.slug || params.id}`, result));
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
      const result = (await marketplaceApi.createListing(listingBody)) as { id?: string; feeQuoteFingerprint?: string };
      let latestResult: unknown = result;

      if (result.id) {
        latestResult = await marketplaceApi.publishListing(result.id, {
          feeQuoteFingerprint: result.feeQuoteFingerprint,
        });
      }

      return redirect(appendFreshWriteToken(`/items/${item.slug || params.id}`, latestResult));
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

function checkoutCommandSnapshot(result: Readonly<{ id: string; version: number; status: string }>) {
  return {
    id: result.id,
    version: result.version,
    status: result.status,
  };
}
