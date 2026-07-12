import { t } from "@chase-sets/localization";
import type { CheckoutSellListLineRow } from "../read-model/queries";
import { isPublicStandardTerms, positiveMoney } from "./sell-list-formatting";
import type {
  LineReadiness,
  SellListInventoryItem,
  SellListOfferReview,
  SellListProductOfferReview,
} from "./sell-list-page-types";

function listingSetupHref(line: CheckoutSellListLineRow, priceAmount: string | null | undefined) {
  const searchParams = new URLSearchParams({
    catalogItemId: line.catalog_catalog_item_id,
  });
  if (positiveMoney(priceAmount) !== null && priceAmount) {
    searchParams.set("recommendedPrice", priceAmount);
  }
  if (line.selected_options.length > 0) {
    searchParams.set("selectedOptions", JSON.stringify(line.selected_options));
  }

  return `/account/listings/new?${searchParams.toString()}`;
}

export function inventorySetupHref(line: CheckoutSellListLineRow) {
  const searchParams = new URLSearchParams({
    catalogItemId: line.catalog_catalog_item_id,
    returnTo: "/account/sell-list",
  });
  if (line.selected_options.length > 0) {
    searchParams.set("selectedOptions", JSON.stringify(line.selected_options));
  }

  return `/account/inventory?${searchParams.toString()}`;
}

function inventoryListingSetupHref(inventoryItemId: string, priceAmount: string | null | undefined) {
  const searchParams = new URLSearchParams({ inventoryItemId });
  if (positiveMoney(priceAmount) !== null && priceAmount) {
    searchParams.set("recommendedPrice", priceAmount);
  }

  return `/account/listings/new?${searchParams.toString()}`;
}

export function sellListLineSetupHref(line: CheckoutSellListLineRow, inventoryItem?: SellListInventoryItem | null) {
  if (line.line_type === "product" && inventoryItem) {
    return inventoryListingSetupHref(inventoryItem.item_id, line.minimum_listing_price_amount);
  }

  return listingSetupHref(
    line,
    line.line_type === "selected-offer" ? line.offer_price_amount : line.minimum_listing_price_amount,
  );
}

export function sellListLineRecoveryHref(line: CheckoutSellListLineRow, inventoryItem?: SellListInventoryItem | null) {
  if (line.line_type === "product" && !inventoryItem) {
    return inventorySetupHref(line);
  }

  return sellListLineSetupHref(line, inventoryItem);
}

export function selectedOfferReadiness(review: SellListOfferReview | undefined): LineReadiness {
  if (review?.status === "ready" && review.terms) {
    return {
      ready: true,
      label: t("checkout.features.sellList.ui.sellListPage.ready"),
      detail: isPublicStandardTerms(review.terms)
        ? t("checkout.features.sellList.ui.sellListPage.public.standard.offer.preview.ready.detail")
        : t("checkout.features.sellList.ui.sellListPage.selected.offer.ready.detail"),
      tone: "success",
    };
  }

  return {
    ready: false,
    label: t("checkout.features.sellList.ui.sellListPage.needs.refresh"),
    detail: review?.message ?? t("checkout.features.sellList.ui.sellListPage.offer.terms.need.refresh"),
    tone: "warning",
  };
}

export function productLineCanSubmitCheckout(options: {
  review: SellListProductOfferReview | undefined;
  defaultInventoryItem: SellListInventoryItem | null;
}): boolean {
  const readyOfferCount = options.review?.offers.length ?? 0;
  return readyOfferCount > 0 || Boolean(options.defaultInventoryItem);
}

export function productLineReadiness(options: {
  review: SellListProductOfferReview | undefined;
  line: CheckoutSellListLineRow;
  defaultInventoryItem: SellListInventoryItem | null;
}): LineReadiness {
  const readyOfferCount = options.review?.offers.length ?? 0;
  const fallbackReady =
    options.line.fallback_mode === "create-listing" &&
    Boolean(options.defaultInventoryItem) &&
    positiveMoney(options.line.minimum_listing_price_amount) !== null;

  if (readyOfferCount > 0 || fallbackReady || (readyOfferCount === 0 && options.defaultInventoryItem)) {
    return {
      ready: true,
      label: t("checkout.features.sellList.ui.sellListPage.ready"),
      detail:
        readyOfferCount > 0
          ? t("checkout.features.sellList.ui.sellListPage.smart.match.ready.detail", { count: readyOfferCount })
          : fallbackReady
            ? t("checkout.features.sellList.ui.sellListPage.fallback.listing.ready.detail")
            : t("checkout.features.sellList.ui.sellListPage.fallback.listing.form.ready.detail"),
      tone: "success",
    };
  }

  return {
    ready: false,
    label: t("checkout.features.sellList.ui.sellListPage.needs.action"),
    detail:
      options.review?.message ?? t("checkout.features.sellList.ui.sellListPage.choose.sale.action.before.checkout"),
    tone: "warning",
  };
}
