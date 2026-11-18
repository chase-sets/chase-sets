import { t } from "@chase-sets/localization";
import type { createMarketplaceRequestApiClient } from "../integrations/marketplace/request-support/api-client";
import type { CheckoutSellListLineRow } from "../read-model/queries";
import type { SellListConfirmationSummary } from "../domain/domain";
import type { SellListReadinessDecisionInput, SellListSellerReadinessReason } from "../domain/readiness";
import { CheckoutDomainError } from "../../../support/runtime-support/common";
import type { SellListReviewPlanLine } from "./review-plan-contracts";
export type ParsedSellListLineAction = NonNullable<SellListReadinessDecisionInput["lineActions"]>[number];

export type SellListReviewedLine = Readonly<{
  line: CheckoutSellListLineRow;
  review: SellListReviewPlanLine;
  readinessAction: ParsedSellListLineAction["action"];
}>;

export type MarketplaceRequestApiClient = Pick<
  ReturnType<typeof createMarketplaceRequestApiClient>,
  "acceptOfferMatch" | "getOfferAcceptanceAttempt" | "createListing" | "publishListing"
>;

export type SellListMarketplaceHandoff = Readonly<{
  completedLineIds: readonly string[];
  remainingLineQuantities: readonly { lineId: string; quantity: number }[];
  summary: SellListConfirmationSummary;
  writeResults: readonly unknown[];
}>;

export type SellListPreparationRefusalReason =
  | Exclude<SellListSellerReadinessReason, "ready">
  | "payout-setup-required"
  | "payout-unavailable"
  | "risk-hold"
  | "risk-block";

export class SellListPreparationRefusedError extends CheckoutDomainError {
  constructor(readonly reasons: readonly SellListPreparationRefusalReason[]) {
    super("Sell List readiness must be resolved before handoff.", "checkout_seller_not_ready");
  }
}

export class SellListReviewPlanStaleError extends Error {
  readonly recovery: Readonly<{ kind: "readiness-stale"; detail: string }>;

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

export function staleManagedOfferReviewError(itemTitle: string) {
  return new SellListReviewPlanStaleError(
    t("checkout.routes.accountSellList.managed.offer.refresh.detail", { itemTitle }),
  );
}
