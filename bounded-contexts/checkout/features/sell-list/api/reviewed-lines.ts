import { CheckoutDomainError } from "../../../support/runtime-support/common";
import { t } from "@chase-sets/localization";
import type { CheckoutSellListLineRow } from "../read-model/queries";
import type { SellListReadinessSnapshot } from "../domain/readiness";
import type { SellListReviewPlan, SellListReviewPlanLine } from "./review-plan-contracts";
import type { ParsedSellListLineAction, SellListReviewedLine } from "./handoff-contracts";
function stableKeyPart(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "unknown";
}

export function reviewedListingId(confirmationId: string, lineId: string) {
  return `lst_${stableKeyPart(confirmationId)}_${stableKeyPart(lineId)}`;
}

function readinessActionByLine(readiness: SellListReadinessSnapshot) {
  return new Map(
    readiness.lineOutcomes
      .filter((outcome) => readiness.includedLineIds.includes(outcome.lineId) && outcome.action)
      .map((outcome) => [outcome.lineId, outcome.action as ParsedSellListLineAction["action"]]),
  );
}

function requireReviewedPlanAction(
  line: CheckoutSellListLineRow,
  review: SellListReviewPlanLine,
  readinessAction: ParsedSellListLineAction["action"],
) {
  if (review.lineType !== line.line_type || review.productId !== line.product_id) {
    throw new CheckoutDomainError(t("checkout.routes.sellCheckoutSession.validation.review.plan.required"));
  }

  switch (readinessAction) {
    case "selected-offer":
      if (
        line.line_type !== "selected-offer" ||
        !review.selectedOffer ||
        review.selectedOffer.offerId !== line.offer_id ||
        review.productOfferTargets.length > 0 ||
        review.fallbackListing
      ) {
        throw new CheckoutDomainError(t("checkout.routes.sellCheckoutSession.validation.review.plan.required"));
      }
      return line.quantity;
    case "smart-match": {
      if (line.line_type !== "product" || review.selectedOffer || review.productOfferTargets.length === 0) {
        throw new CheckoutDomainError(t("checkout.routes.sellCheckoutSession.validation.review.plan.required"));
      }
      return (
        review.productOfferTargets.reduce((sum, target) => sum + target.quantity, 0) +
        (review.fallbackListing?.quantityCap ?? 0)
      );
    }
    case "fallback-listing":
      if (
        line.line_type !== "product" ||
        review.selectedOffer ||
        review.productOfferTargets.length > 0 ||
        !review.fallbackListing
      ) {
        throw new CheckoutDomainError(t("checkout.routes.sellCheckoutSession.validation.review.plan.required"));
      }
      return review.fallbackListing.quantityCap;
  }
}

export function reviewedLinesForConfirmation(
  lines: readonly CheckoutSellListLineRow[],
  readiness: SellListReadinessSnapshot,
  plan: SellListReviewPlan | null,
): readonly SellListReviewedLine[] {
  if (!plan) {
    throw new CheckoutDomainError(t("checkout.routes.sellCheckoutSession.validation.review.plan.required"));
  }

  const linesById = new Map(lines.map((line) => [line.line_id, line]));
  const planByLineId = new Map(plan.lines.map((line) => [line.lineId, line]));
  const actionByLineId = readinessActionByLine(readiness);
  const reviewed: SellListReviewedLine[] = [];

  for (const lineId of readiness.includedLineIds) {
    const line = linesById.get(lineId);
    const review = planByLineId.get(lineId);
    const readinessAction = actionByLineId.get(lineId);
    if (!line || !review || !readinessAction || review.skippedReasons.length > 0) {
      throw new CheckoutDomainError(t("checkout.routes.sellCheckoutSession.validation.review.plan.required"));
    }
    const reviewedQuantity = requireReviewedPlanAction(line, review, readinessAction);
    if (reviewedQuantity > line.quantity) {
      throw new CheckoutDomainError(t("checkout.routes.sellCheckoutSession.validation.review.plan.required"));
    }
    reviewed.push({ line, review, readinessAction });
  }

  return reviewed;
}
