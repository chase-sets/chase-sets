import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, CheckoutSessionId } from "@chase-sets/primitives/typed-ids";
import type { CheckoutFulfillmentPreview } from "../domain/fulfillment-preview";
import type { CheckoutSessionServices } from "./runtime";
import { CheckoutDomainError } from "../../../support/runtime-support/common";
import { previewBuyNowCheckoutSupplyThroughOrdering } from "../../../support/request-support/checkout-confirmation";

export type BuyNowPreparationListing = Readonly<{
  listingId: string;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  productSummary: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
}>;

export async function prepareBuyNowCheckout(
  params: Readonly<{
    request: Request;
    services: Pick<CheckoutSessionServices, "createBuyNow">;
    accountId: AccountId;
    listing: BuyNowPreparationListing;
    quantity: number;
    context: EventStoreContext;
    sessionIdOverride?: CheckoutSessionId;
    handoffExpiresAt?: string | null;
    shippingOption?: "standard" | "expedited" | "priority";
  }>,
): Promise<{ sessionId: CheckoutSessionId; fulfillmentPreview: CheckoutFulfillmentPreview }> {
  if (!Number.isInteger(params.quantity) || params.quantity < 1) {
    throw new CheckoutDomainError("Quantity must be a positive integer.", "invalid_quantity");
  }
  const line = {
    listingId: params.listing.listingId,
    cartLineId: null,
    catalogItemId: params.listing.catalogItemId,
    productId: params.listing.productId,
    itemTitle: params.listing.itemTitle,
    itemSubtitle: params.listing.itemSubtitle,
    selectedOptions: [...params.listing.selectedOptions],
    productSummary: params.listing.productSummary,
    quantity: params.quantity,
    fulfillmentMode: "locked-listing" as const,
    lockedListingId: params.listing.listingId,
    sellerPreferenceId: null,
  };
  const fulfillmentPreview = await previewBuyNowCheckoutSupplyThroughOrdering(params.request, {
    checkoutSessionId: params.sessionIdOverride ?? `chk_preflight_${params.listing.listingId}`,
    shippingOption: params.shippingOption ?? "standard",
    optimizationGoal: "lowest-total",
    line,
  });
  if (fulfillmentPreview.readyLineKeys.length === 0) {
    throw new CheckoutDomainError("This item is no longer available.", "item_unavailable");
  }
  const result = await params.services.createBuyNow(
    {
      accountId: params.accountId,
      listingId: params.listing.listingId,
      catalogItemId: params.listing.catalogItemId,
      productId: params.listing.productId,
      itemTitle: params.listing.itemTitle,
      itemSubtitle: params.listing.itemSubtitle,
      selectedOptions: [...params.listing.selectedOptions],
      productSummary: params.listing.productSummary,
      quantity: params.quantity,
      fulfillmentMode: "locked-listing",
      lockedListingId: params.listing.listingId,
      sellerPreferenceId: null,
      fulfillmentPreviewRevision: fulfillmentPreview.revision,
      fulfillmentPreviewSnapshot: fulfillmentPreview,
      handoffExpiresAt: params.handoffExpiresAt,
      sessionIdOverride: params.sessionIdOverride,
    },
    params.context,
  );
  return { sessionId: result.sessionId, fulfillmentPreview };
}
