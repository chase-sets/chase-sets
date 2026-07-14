import { t } from "@chase-sets/localization";
import type { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
import type {
  CheckoutSellListConfirmationRow,
  CheckoutSellListLineRow,
  SellListConfirmationSummary,
  SellListReadinessDecisionInput,
  SellListReadinessSnapshot,
} from "../../request-support/api-client";
import type {
  GuestSellCheckoutFormValues,
  GuestSellCheckoutRecovery,
} from "../../../features/sell-list/ui/guest-sell-checkout-page";
import type {
  SignedInSellCheckoutFormValues,
  SignedInSellCheckoutPayoutSummary,
  SignedInSellCheckoutRecovery,
  SignedInSellCheckoutShipFromAddress,
} from "../../../features/sell-list/ui/signed-in-sell-checkout-page";

export type GuestSellCheckoutLoaderData = Readonly<{
  mode: "guest";
  sessionId: string;
  lines: readonly CheckoutSellListLineRow[];
  readiness: SellListReadinessSnapshot | null;
  recovery: GuestSellCheckoutRecovery | null;
  defaultValues: GuestSellCheckoutFormValues;
}>;

export type SignedInSellCheckoutLoaderData = Readonly<{
  mode: "signed-in";
  sessionId: string;
  lines: readonly CheckoutSellListLineRow[];
  readiness: SellListReadinessSnapshot | null;
  recovery: SignedInSellCheckoutRecovery | null;
  defaultValues: SignedInSellCheckoutFormValues;
  savedShipFromAddresses: readonly SignedInSellCheckoutShipFromAddress[];
  payoutSummary: SignedInSellCheckoutPayoutSummary | null;
  readinessDecisions: string;
  sellListReviewPlan: string;
}>;

export type SellCheckoutLoaderData = GuestSellCheckoutLoaderData | SignedInSellCheckoutLoaderData;

export type ParsedSellListLineAction = NonNullable<SellListReadinessDecisionInput["lineActions"]>[number];
export type ParsedSellListLineOutcome = NonNullable<SellListReadinessDecisionInput["lineOutcomes"]>[number];

export type SellListReviewPlan = Readonly<{
  version: 1;
  lines: readonly SellListReviewPlanLine[];
}>;

export type SellListReviewPlanLine = Readonly<{
  lineId: string;
  lineType: "selected-offer" | "product";
  itemTitle: string;
  productId: string | null;
  quantity: number;
  selectedOffer: Readonly<{ offerId: string; listingId: string; feeQuoteFingerprint: string }> | null;
  productOfferTargets: readonly Readonly<{
    offerId: string;
    listingId: string;
    feeQuoteFingerprint: string;
    quantity: number;
  }>[];
  fallbackListing: Readonly<{ inventoryItemId: string; priceAmount: string; quantityCap: number }> | null;
  skippedReasons: readonly string[];
}>;

export type SellListReviewedLine = Readonly<{
  line: CheckoutSellListLineRow;
  review: SellListReviewPlanLine;
  readinessAction: ParsedSellListLineAction["action"];
}>;

export type MarketplaceRequestApiClient = ReturnType<typeof createMarketplaceRequestApiClient>;

export type SellListMarketplaceHandoff = Readonly<{
  completedLineIds: readonly string[];
  remainingLineQuantities: readonly { lineId: string; quantity: number }[];
  summary: SellListConfirmationSummary;
  writeResults: readonly unknown[];
}>;

export type SellListConfirmResponse = Readonly<{
  confirmation: CheckoutSellListConfirmationRow;
}>;

export class SellListReviewPlanStaleError extends Error {
  readonly recovery: SignedInSellCheckoutRecovery;

  constructor(detail: string) {
    super(detail);
    this.name = "SellListReviewPlanStaleError";
    this.recovery = { kind: "readiness-stale", detail };
  }
}

export function staleReviewPlanError(itemTitle: string) {
  return new SellListReviewPlanStaleError(
    t("checkout.routes.accountSellList.offer.terms.need.refresh.detail", { itemTitle }),
  );
}
