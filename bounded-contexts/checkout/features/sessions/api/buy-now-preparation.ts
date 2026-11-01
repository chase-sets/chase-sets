import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, CheckoutSessionId } from "@chase-sets/primitives/typed-ids";
import type { CheckoutFulfillmentPreview } from "../domain/fulfillment-preview";
import type { CheckoutSessionServices } from "./runtime";
import type { CheckoutEntryAttempt } from "../../command-attempts/api/entry-attempt";
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
    entryAttempt?: CheckoutEntryAttempt;
    handoffExpiresAt?: string | null;
    createdAt?: string;
    preflightSessionId?: string;
    lockedListingId?: string;
    sellerPreferenceId?: string | null;
    shippingOption?: "standard" | "expedited" | "priority";
    optimizationGoal?: "fewest-shipments" | "lowest-total";
  }>,
): Promise<
  Awaited<ReturnType<CheckoutSessionServices["createBuyNow"]>> & {
    fulfillmentPreview: CheckoutFulfillmentPreview;
    writeSources: readonly unknown[];
  }
> {
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
    lockedListingId: params.lockedListingId ?? params.listing.listingId,
    sellerPreferenceId: params.sellerPreferenceId ?? null,
  };
  const fulfillmentPreview = await previewBuyNowCheckoutSupplyThroughOrdering(params.request, {
    checkoutSessionId:
      params.sessionIdOverride ?? params.preflightSessionId ?? `chk_preflight_${params.listing.listingId}`,
    shippingOption: params.shippingOption ?? "standard",
    optimizationGoal: params.optimizationGoal ?? "lowest-total",
    line,
  });
  if (fulfillmentPreview.readyLineKeys.length === 0) {
    throw unresolvedFulfillment(fulfillmentPreview);
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
      lockedListingId: line.lockedListingId,
      sellerPreferenceId: line.sellerPreferenceId,
      shippingOption: params.shippingOption,
      optimizationGoal: params.optimizationGoal,
      fulfillmentPreviewRevision: fulfillmentPreview.revision,
      fulfillmentPreviewSnapshot: fulfillmentPreview,
      handoffExpiresAt: params.handoffExpiresAt,
      createdAt: params.createdAt,
      sessionIdOverride: params.sessionIdOverride,
      entryAttempt: params.entryAttempt,
    },
    params.context,
  );
  return { ...result, fulfillmentPreview, writeSources: [result] };
}

function unresolvedFulfillment(preview: CheckoutFulfillmentPreview) {
  const reason = preview.unavailableLines[0]?.reason?.trim();
  return new CheckoutDomainError(
    reason && reason !== "Locked listing is unavailable."
      ? reason
      : "This listing is still becoming available for checkout. Try again shortly.",
    "unresolved_fulfillment",
  );
}
