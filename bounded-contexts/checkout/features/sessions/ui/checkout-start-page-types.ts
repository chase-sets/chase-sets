import type { CartReadinessSnapshot } from "../../../support/request-support/api-client";
import type { CheckoutRecovery } from "../api/checkout-recovery";

export type CheckoutStartOfferIntentSource = Readonly<{
  type: "offer-intent";
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  offerPriceAmount: string;
  quantity: number;
}>;

export type CheckoutStartBuyNowSource = Readonly<{
  type: "buy-now";
  listingId: string;
  fulfillmentMode: "locked-listing" | "optimize";
  lockedListingId: string | null;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  quantity: number;
  priceAmount: string | null;
  sellerName: string | null;
  availability: string | null;
  fulfillment: string | null;
}>;

/** The checkout entry the buyer arrived with: a buy-now listing, an
 * offer-intent, or (null) the whole cart. */
export type CheckoutStartSource = CheckoutStartOfferIntentSource | CheckoutStartBuyNowSource;

export type CheckoutStartCartReadinessSummary = Readonly<{
  status: CartReadinessSnapshot["status"];
  lineCount: number;
  customerSafeFacts: readonly string[];
}>;

export type CheckoutStartPageData = Readonly<{
  isSignedIn: boolean;
  isGuestBuyer: boolean;
  source: CheckoutStartSource | null;
  cartReadiness: CheckoutStartCartReadinessSummary | null;
  cartCount: number;
  entryAttemptKey: string;
  signInPath: string;
}>;

export type CheckoutStartActionData =
  | Readonly<{ error: string; signInPath: string }>
  | Readonly<{ recovery: CheckoutRecovery }>;
