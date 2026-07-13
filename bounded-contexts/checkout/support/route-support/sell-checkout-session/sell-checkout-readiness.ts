import { t } from "@chase-sets/localization";
import type {
  CheckoutSellListLineRow,
  SellListReadinessDecisionInput,
  SellListReadinessSnapshot,
} from "../../request-support/api-client";
import type { GuestSellCheckoutRecovery } from "../../../features/sell-list/ui/guest-sell-checkout-page";
import type { SignedInSellCheckoutRecovery } from "../../../features/sell-list/ui/signed-in-sell-checkout-page";
import { normalizeQueryText, objectValue, positiveIntegerValue, stringValue } from "./sell-checkout-form";
import type {
  ParsedSellListLineAction,
  ParsedSellListLineOutcome,
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

export function parseSellListReviewPlan(value: string): SellListReviewPlan | null {
  if (!value.trim()) {
    return null;
  }

  try {
    const source = objectValue(JSON.parse(value));
    if (!source || source.version !== 1 || !Array.isArray(source.lines)) {
      return null;
    }

    const lines = source.lines
      .map(objectValue)
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map((entry): SellListReviewPlanLine | null => {
        const lineId = stringValue(entry.lineId);
        const lineType =
          entry.lineType === "selected-offer" ? "selected-offer" : entry.lineType === "product" ? "product" : null;
        if (!lineId || !lineType) {
          return null;
        }

        const selectedOfferSource = objectValue(entry.selectedOffer);
        const selectedOffer =
          selectedOfferSource &&
          stringValue(selectedOfferSource.offerId) &&
          stringValue(selectedOfferSource.listingId) &&
          stringValue(selectedOfferSource.feeQuoteFingerprint)
            ? {
                offerId: stringValue(selectedOfferSource.offerId),
                listingId: stringValue(selectedOfferSource.listingId),
                feeQuoteFingerprint: stringValue(selectedOfferSource.feeQuoteFingerprint),
              }
            : null;
        const productOfferTargets = Array.isArray(entry.productOfferTargets)
          ? entry.productOfferTargets
              .map(objectValue)
              .filter((target): target is Record<string, unknown> => target !== null)
              .map((target) => ({
                offerId: stringValue(target.offerId),
                listingId: stringValue(target.listingId),
                feeQuoteFingerprint: stringValue(target.feeQuoteFingerprint),
                quantity: positiveIntegerValue(target.quantity),
              }))
              .filter(
                (target) => target.offerId && target.listingId && target.feeQuoteFingerprint && target.quantity > 0,
              )
          : [];
        const fallbackSource = objectValue(entry.fallbackListing);
        const fallbackListing =
          fallbackSource &&
          stringValue(fallbackSource.inventoryItemId) &&
          stringValue(fallbackSource.priceAmount) &&
          positiveIntegerValue(fallbackSource.quantityCap) > 0
            ? {
                inventoryItemId: stringValue(fallbackSource.inventoryItemId),
                priceAmount: stringValue(fallbackSource.priceAmount),
                quantityCap: positiveIntegerValue(fallbackSource.quantityCap),
              }
            : null;

        return {
          lineId,
          lineType,
          itemTitle: stringValue(entry.itemTitle),
          productId: stringValue(entry.productId) || null,
          quantity: positiveIntegerValue(entry.quantity),
          selectedOffer,
          productOfferTargets,
          fallbackListing,
          skippedReasons: Array.isArray(entry.skippedReasons)
            ? entry.skippedReasons
                .map(String)
                .map((reason) => reason.trim())
                .filter(Boolean)
            : [],
        };
      })
      .filter((line): line is SellListReviewPlanLine => line !== null);

    return { version: 1, lines };
  } catch {
    return null;
  }
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

export function parseSellListReadinessDecisions(value: string): SellListReadinessDecisionInput {
  if (!value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as {
      lineActions?: unknown;
      lineOutcomes?: unknown;
    };
    const lineActions = Array.isArray(parsed.lineActions)
      ? parsed.lineActions
          .map((action) => {
            if (!action || typeof action !== "object") {
              return null;
            }
            const lineId = String((action as { lineId?: unknown }).lineId ?? "").trim();
            const actionValue = String((action as { action?: unknown }).action ?? "").trim();
            if (
              !lineId ||
              (actionValue !== "selected-offer" && actionValue !== "smart-match" && actionValue !== "fallback-listing")
            ) {
              return null;
            }
            return { lineId, action: actionValue };
          })
          .filter((action): action is ParsedSellListLineAction => Boolean(action))
      : [];
    const lineOutcomes = Array.isArray(parsed.lineOutcomes)
      ? parsed.lineOutcomes
          .map((outcome) => {
            if (!outcome || typeof outcome !== "object") {
              return null;
            }
            const lineId = String((outcome as { lineId?: unknown }).lineId ?? "").trim();
            const outcomeValue = String((outcome as { outcome?: unknown }).outcome ?? "").trim();
            if (!lineId || outcomeValue !== "keep-in-list") {
              return null;
            }
            return { lineId, outcome: outcomeValue };
          })
          .filter((outcome): outcome is ParsedSellListLineOutcome => Boolean(outcome))
      : [];

    return { lineActions, lineOutcomes };
  } catch {
    return {};
  }
}

export function encodeSellListReadinessDecisions(decisions: SellListReadinessDecisionInput) {
  return JSON.stringify({
    lineActions: decisions.lineActions ?? [],
    lineOutcomes: decisions.lineOutcomes ?? [],
  });
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
