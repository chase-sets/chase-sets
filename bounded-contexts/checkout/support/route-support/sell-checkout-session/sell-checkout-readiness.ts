import { t } from "@chase-sets/localization";
import type { CheckoutSellListLineRow, SellListReadinessSnapshot } from "../../request-support/api-client";
import type { GuestSellCheckoutRecovery } from "../../../features/sell-list/ui/guest-sell-checkout-page";
import type { SignedInSellCheckoutRecovery } from "../../../features/sell-list/ui/signed-in-sell-checkout-page";
import { normalizeQueryText } from "./sell-checkout-form";
import type {
  ParsedSellListLineAction,
  SellListReviewPlan,
  SellListReviewPlanLine,
  SellListReviewedLine,
} from "./sell-checkout-types";

export function recoveryFromSearchParams(searchParams: URLSearchParams): GuestSellCheckoutRecovery | null {
  const recovery = normalizeQueryText(searchParams, "recovery");
  if (
    recovery === "missing-sell-list" ||
    recovery === "empty-sell-list" ||
    recovery === "readiness-required" ||
    recovery === "readiness-stale" ||
    recovery === "readiness-blocked"
  ) {
    return { kind: recovery };
  }

  return null;
}

export function signedInRecoveryFromSearchParams(searchParams: URLSearchParams): SignedInSellCheckoutRecovery | null {
  const recovery = normalizeQueryText(searchParams, "recovery");
  if (
    recovery === "access-required" ||
    recovery === "missing-sell-list" ||
    recovery === "empty-sell-list" ||
    recovery === "readiness-required" ||
    recovery === "readiness-stale" ||
    recovery === "readiness-blocked"
  ) {
    return { kind: recovery };
  }

  return null;
}

function stableKeyPart(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "unknown";
}

export function confirmationIdForSession(sessionId: string) {
  return `slc_${stableKeyPart(sessionId)}`;
}

export function confirmationPathForSession(sessionId: string) {
  return `/checkout/sell/session/${stableKeyPart(sessionId)}/confirmation`;
}

export function reviewedListingId(confirmationId: string, lineId: string) {
  return `lst_${stableKeyPart(confirmationId)}_${stableKeyPart(lineId)}`;
}

export function filterIncludedLines(lines: readonly CheckoutSellListLineRow[], readiness: SellListReadinessSnapshot) {
  const includedLineIds = new Set(readiness.includedLineIds);
  return lines.filter((line) => includedLineIds.has(line.line_id));
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
    throw new Error(t("checkout.routes.sellCheckoutSession.validation.review.plan.required"));
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
        throw new Error(t("checkout.routes.sellCheckoutSession.validation.review.plan.required"));
      }
      return line.quantity;
    case "smart-match": {
      if (line.line_type !== "product" || review.selectedOffer || review.productOfferTargets.length === 0) {
        throw new Error(t("checkout.routes.sellCheckoutSession.validation.review.plan.required"));
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
        throw new Error(t("checkout.routes.sellCheckoutSession.validation.review.plan.required"));
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
    throw new Error(t("checkout.routes.sellCheckoutSession.validation.review.plan.required"));
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
      throw new Error(t("checkout.routes.sellCheckoutSession.validation.review.plan.required"));
    }
    const reviewedQuantity = requireReviewedPlanAction(line, review, readinessAction);
    if (reviewedQuantity > line.quantity) {
      throw new Error(t("checkout.routes.sellCheckoutSession.validation.review.plan.required"));
    }
    reviewed.push({ line, review, readinessAction });
  }

  return reviewed;
}
