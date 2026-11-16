import { t } from "@chase-sets/localization";
import type { SellListReadinessDecisionInput } from "../domain/readiness";
import type { CheckoutSellListLineRow, CheckoutSellOfferMatch } from "../read-model/queries";
import type { SellListReviewPlan, SellListReviewPlanLine, SellListReviewSelections } from "./review-plan-contracts";

export async function buildSellListReviewPlan(
  getOfferMatch: (offerId: string) => Promise<CheckoutSellOfferMatch | null>,
  lines: readonly CheckoutSellListLineRow[],
  selections: SellListReviewSelections,
): Promise<SellListReviewPlan> {
  const reviewLines: SellListReviewPlanLine[] = [];
  const bulkOfferIds = new Set(selections.bulkOfferIds ?? []);
  const isBulkOfferReview = bulkOfferIds.size > 0;

  for (const line of lines) {
    const selection = selections.lines.find((entry) => entry.lineId === line.line_id);
    if (line.line_type === "selected-offer") {
      const skippedReasons: string[] = [];
      const feeQuoteFingerprint = selection?.selectedOfferFeeQuoteFingerprint?.trim();
      let selectedOffer: SellListReviewPlanLine["selectedOffer"] = null;

      if (isBulkOfferReview && (!line.offer_id || !bulkOfferIds.has(line.offer_id))) {
        // Unselected lines remain durable Sell List intent.
      } else if (!line.offer_id || !line.listing_id) {
        skippedReasons.push(
          t("checkout.routes.accountSellList.selected.offer.missing.detail", { itemTitle: line.item_title }),
        );
      } else if (!feeQuoteFingerprint) {
        skippedReasons.push(
          t("checkout.routes.accountSellList.offer.terms.need.refresh.detail", { itemTitle: line.item_title }),
        );
      } else {
        selectedOffer = { offerId: line.offer_id, listingId: line.listing_id, feeQuoteFingerprint };
      }

      reviewLines.push({
        lineId: line.line_id,
        lineType: "selected-offer",
        itemTitle: line.item_title,
        productId: line.product_id,
        quantity: line.quantity,
        selectedOffer,
        productOfferTargets: [],
        fallbackListing: null,
        skippedReasons,
      });
      continue;
    }

    const skippedReasons: string[] = [];
    const productOfferTargets: Array<{
      offerId: string;
      listingId: string;
      feeQuoteFingerprint: string;
      quantity: number;
    }> = [];
    let plannedRemainingQuantity = line.quantity;

    for (const offerId of [
      ...new Set(
        (selection?.productOffers ?? [])
          .map((target) => target.offerId.trim())
          .filter((value) => Boolean(value) && (!isBulkOfferReview || bulkOfferIds.has(value))),
      ),
    ]) {
      try {
        const offer = await getOfferMatch(offerId);
        if (!offer) throw new Error(t("checkout.features.sellList.api.route.offer.match.not.found"));
        if (offer.product_id !== line.product_id) {
          skippedReasons.push(`${line.item_title}: matching offer ${offerId} no longer matches this product.`);
          continue;
        }
        if (offer.quantity_requested > plannedRemainingQuantity) {
          skippedReasons.push(`${line.item_title}: matching offer ${offerId} exceeds remaining quantity.`);
          continue;
        }
        const feeQuoteFingerprint = selection?.productOffers
          ?.find((target) => target.offerId.trim() === offerId)
          ?.feeQuoteFingerprint.trim();
        if (!feeQuoteFingerprint) {
          skippedReasons.push(`${line.item_title}: matching offer terms need refresh.`);
          continue;
        }
        productOfferTargets.push({
          offerId,
          listingId: offer.listing_id,
          feeQuoteFingerprint,
          quantity: offer.quantity_requested,
        });
        plannedRemainingQuantity -= offer.quantity_requested;
      } catch (error) {
        skippedReasons.push(`${line.item_title}: ${error instanceof Error ? error.message : "offer match failed"}`);
      }
    }

    const createFallbackListing = !isBulkOfferReview && Boolean(selection?.fallbackListing);
    let fallbackListing: SellListReviewPlanLine["fallbackListing"] = null;
    if (plannedRemainingQuantity > 0 && createFallbackListing) {
      const inventoryItemId = selection!.fallbackListing!.inventoryItemId.trim();
      const priceAmount = selection!.fallbackListing!.priceAmount.trim();
      const priceCurrencyCode = selection!.fallbackListing!.priceCurrencyCode.trim();
      const requestedQuantityCap = Number(selection!.fallbackListing!.quantityCap || plannedRemainingQuantity);
      const quantityCap = Math.min(plannedRemainingQuantity, requestedQuantityCap);
      if (
        !inventoryItemId ||
        !priceAmount ||
        !priceCurrencyCode ||
        !Number.isSafeInteger(quantityCap) ||
        quantityCap < 1
      ) {
        skippedReasons.push(`${line.item_title}: listing needs inventory, price, currency, and quantity.`);
      } else {
        fallbackListing = { inventoryItemId, priceAmount, priceCurrencyCode, quantityCap };
      }
    } else if (plannedRemainingQuantity > 0 && !isBulkOfferReview) {
      skippedReasons.push(
        t("checkout.routes.accountSellList.matching.offers.do.not.cover.quantity.detail", {
          itemTitle: line.item_title,
        }),
      );
    }

    reviewLines.push({
      lineId: line.line_id,
      lineType: "product",
      itemTitle: line.item_title,
      productId: line.product_id,
      quantity: line.quantity,
      selectedOffer: null,
      productOfferTargets,
      fallbackListing,
      skippedReasons,
    });
  }

  return { version: 1, lines: reviewLines };
}

export function readinessDecisionsFromReviewPlan(plan: SellListReviewPlan): SellListReadinessDecisionInput {
  const lineActions: Array<NonNullable<SellListReadinessDecisionInput["lineActions"]>[number]> = [];
  const lineOutcomes: Array<NonNullable<SellListReadinessDecisionInput["lineOutcomes"]>[number]> = [];

  for (const line of plan.lines) {
    if (line.skippedReasons.length > 0) {
      lineOutcomes.push({ lineId: line.lineId, outcome: "keep-in-list" });
      continue;
    }

    if (line.lineType === "selected-offer" && line.selectedOffer) {
      lineActions.push({ lineId: line.lineId, action: "selected-offer" });
      continue;
    }

    if (line.productOfferTargets.length > 0) {
      lineActions.push({ lineId: line.lineId, action: "smart-match" });
      continue;
    }

    if (line.fallbackListing) {
      lineActions.push({ lineId: line.lineId, action: "fallback-listing" });
      continue;
    }

    lineOutcomes.push({ lineId: line.lineId, outcome: "keep-in-list" });
  }

  return { lineActions, lineOutcomes };
}
