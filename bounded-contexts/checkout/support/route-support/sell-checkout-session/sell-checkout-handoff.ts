import { t } from "@chase-sets/localization";
import type { SellListLineId } from "../../runtime-support/common";
import { MarketplaceApiError } from "@chase-sets/marketplace/server";
import type {
  CheckoutSellListConfirmationRow,
  SellListConfirmationSummary,
  SellListSellerConfirmationEvidence,
} from "../../request-support/api-client";
import type {
  SignedInSellCheckoutFormValues,
  SignedInSellCheckoutPayoutSummary,
} from "../../../features/sell-list/ui/signed-in-sell-checkout-page";
import { objectValue, stringValue } from "./sell-checkout-form";
import { reviewedListingId } from "./sell-checkout-readiness";
import {
  staleReviewPlanError,
  type MarketplaceRequestApiClient,
  type SellListMarketplaceHandoff,
  type SellListReviewedLine,
} from "./sell-checkout-types";

function sideEffectsForMarketplaceHandoff(
  acceptedOfferCount: number,
  publishedListingCount: number,
): SellListConfirmationSummary["sideEffects"] {
  const hasAcceptedOffer = acceptedOfferCount > 0;
  const hasMarketplaceHandoff = hasAcceptedOffer || publishedListingCount > 0;
  return {
    sale: hasAcceptedOffer ? "handoff-recorded" : "not-applicable",
    label: hasAcceptedOffer ? "pending-downstream" : "not-applicable",
    payout: hasAcceptedOffer ? "pending-downstream" : "not-applicable",
    settlement: hasAcceptedOffer ? "pending-downstream" : "not-applicable",
    notification: hasMarketplaceHandoff ? "pending-downstream" : "not-applicable",
    accountHistory: hasMarketplaceHandoff ? "pending-downstream" : "not-applicable",
  };
}

function normalizeSideEffectStatus(value: unknown): SellListConfirmationSummary["sideEffects"]["sale"] {
  return value === "not-attempted" ||
    value === "not-applicable" ||
    value === "handoff-recorded" ||
    value === "pending-downstream" ||
    value === "failed"
    ? value
    : "not-attempted";
}

export function confirmationSideEffects(
  summary: CheckoutSellListConfirmationRow["handoff_summary"],
): SellListConfirmationSummary["sideEffects"] {
  const sideEffects = objectValue(summary.sideEffects);
  return {
    sale: normalizeSideEffectStatus(sideEffects?.sale),
    label: normalizeSideEffectStatus(sideEffects?.label),
    payout: normalizeSideEffectStatus(sideEffects?.payout),
    settlement: normalizeSideEffectStatus(sideEffects?.settlement),
    notification: normalizeSideEffectStatus(sideEffects?.notification),
    accountHistory: normalizeSideEffectStatus(sideEffects?.accountHistory),
  };
}

export function buildSellerEvidence(
  values: SignedInSellCheckoutFormValues,
  payoutSummary: SignedInSellCheckoutPayoutSummary | null,
): SellListSellerConfirmationEvidence {
  return {
    shipFrom: {
      status: "ready",
      addressId: values.shipFromAddressId === "__manual" ? null : values.shipFromAddressId,
      country: values.shipFromCountry,
      region: values.shipFromState,
      postalCode: values.shipFromPostalCode,
    },
    payout: {
      status: "ready",
      method: "saved-payout",
      readinessStatus: payoutSummary?.status ?? values.payoutState,
      lastCheckedAt: null,
    },
    label: {
      status: "ready",
      preference: values.labelPreference === "seller-label-later" ? "seller-label-later" : "prepaid-label",
    },
    risk: { status: "clear" },
    provider: { status: "ready" },
    freshness: { status: "current" },
  };
}

function responseString(value: unknown, ...keys: string[]) {
  const source = objectValue(value);
  if (!source) {
    return "";
  }

  for (const key of keys) {
    const result = stringValue(source[key]);
    if (result) {
      return result;
    }
  }
  return "";
}

function errorBodyMessage(value: unknown) {
  const source = objectValue(value);
  const error = objectValue(source?.error);
  return stringValue(error?.message) || stringValue(source?.message);
}

function isAlreadyActiveListingPublishReplay(error: unknown) {
  return error instanceof MarketplaceApiError && errorBodyMessage(error.body).includes("already active");
}

function marketplaceErrorCode(error: unknown): string {
  if (!(error instanceof MarketplaceApiError)) {
    return "";
  }
  const body = objectValue(error.body);
  const bodyError = objectValue(body?.error);
  return stringValue(bodyError?.code);
}

/**
 * Codes Marketplace returns when the exact Listing / Offer it revalidates at
 * acceptance no longer matches what the seller reviewed: stale fee quote, stale
 * or incomplete Listing Evidence, or an ineligible Listing. Each maps to a
 * "re-review" recovery so the seller sees the refreshed requirement before any
 * further side effects run.
 */
const OFFER_ACCEPTANCE_STALE_CODES = new Set([
  "fee_quote_stale",
  "listing_evidence_incomplete",
  "listing_seller_trust_incomplete",
  "listing_not_eligible",
]);

/**
 * Accept one Offer against its exact Listing, tolerating idempotent replays and
 * converting Marketplace revalidation failures into a re-review recovery.
 *
 * `offer_already_accepted` is a benign replay (duplicate submit, browser
 * refresh, or a partially completed batch being retried): the acceptance
 * already exists in Marketplace, so the line counts as completed with a `null`
 * write (no new side effect). Stale / ineligible responses abort the remaining
 * batch and surface the refreshed requirement for review.
 */
async function acceptOfferMatchWithRecovery(
  marketplaceApi: MarketplaceRequestApiClient,
  offerId: string,
  itemTitle: string,
  body: Parameters<MarketplaceRequestApiClient["acceptOfferMatch"]>[1],
): Promise<unknown | null> {
  try {
    return await marketplaceApi.acceptOfferMatch(offerId, body);
  } catch (error) {
    const code = marketplaceErrorCode(error);
    if (code === "offer_already_accepted") {
      return null;
    }
    if (OFFER_ACCEPTANCE_STALE_CODES.has(code)) {
      throw staleReviewPlanError(itemTitle);
    }
    throw error;
  }
}

export async function performMarketplaceHandoff(
  marketplaceApi: MarketplaceRequestApiClient,
  confirmationId: string,
  reviewedLines: readonly SellListReviewedLine[],
): Promise<SellListMarketplaceHandoff> {
  const completedLineIds: string[] = [];
  const remainingLineQuantities: { lineId: string; quantity: number }[] = [];
  const lineOutcomes: Array<NonNullable<SellListConfirmationSummary["lineOutcomes"]>[number]> = [];
  const writeResults: unknown[] = [];
  let acceptedOfferCount = 0;
  let publishedListingCount = 0;

  for (const { line, review, readinessAction } of reviewedLines) {
    const acceptedOfferIds: string[] = [];
    let listingId: string | null = null;
    let completedQuantity = 0;

    if (readinessAction === "selected-offer" && review.selectedOffer) {
      const result = await acceptOfferMatchWithRecovery(marketplaceApi, review.selectedOffer.offerId, line.item_title, {
        listingId: review.selectedOffer.listingId,
        feeQuoteFingerprint: review.selectedOffer.feeQuoteFingerprint,
        sourceActionKey: `sell-confirm:${confirmationId}:${line.line_id}:selected:${review.selectedOffer.offerId}`,
      });
      if (result) {
        writeResults.push(result);
      }
      acceptedOfferIds.push(review.selectedOffer.offerId);
      completedQuantity += line.quantity;
      acceptedOfferCount += 1;
    }

    if (readinessAction === "smart-match") {
      const acceptanceBatchId = `offer-acceptance:${confirmationId}:${line.line_id}`;
      for (const target of review.productOfferTargets) {
        const result = await acceptOfferMatchWithRecovery(marketplaceApi, target.offerId, line.item_title, {
          listingId: target.listingId,
          feeQuoteFingerprint: target.feeQuoteFingerprint,
          sourceActionKey: `sell-confirm:${confirmationId}:${line.line_id}:match:${target.offerId}`,
          acceptanceBatchId,
          acceptanceBatchSize: review.productOfferTargets.length,
        });
        if (result) {
          writeResults.push(result);
        }
        acceptedOfferIds.push(target.offerId);
        completedQuantity += target.quantity;
        acceptedOfferCount += 1;
      }
    }

    if ((readinessAction === "fallback-listing" || review.fallbackListing) && review.fallbackListing) {
      const listingIdOverride = reviewedListingId(confirmationId, line.line_id);
      const createdListing = await marketplaceApi.createListing({
        inventoryItemId: review.fallbackListing.inventoryItemId,
        priceAmount: review.fallbackListing.priceAmount,
        quantityCap: review.fallbackListing.quantityCap,
        listingIdOverride,
      });
      writeResults.push(createdListing);
      listingId = responseString(createdListing, "id", "listingId", "listing_id") || listingIdOverride;
      try {
        const result = await marketplaceApi.publishListing(listingId, {
          feeQuoteFingerprint: responseString(createdListing, "feeQuoteFingerprint", "fee_quote_fingerprint") || null,
        });
        writeResults.push(result);
      } catch (error) {
        if (!isAlreadyActiveListingPublishReplay(error)) {
          throw error;
        }
      }
      completedQuantity += review.fallbackListing.quantityCap;
      publishedListingCount += 1;
    }

    const remainingQuantity = Math.max(0, line.quantity - completedQuantity);
    if (remainingQuantity > 0) {
      remainingLineQuantities.push({ lineId: line.line_id, quantity: remainingQuantity });
    } else {
      completedLineIds.push(line.line_id);
    }

    lineOutcomes.push({
      lineId: line.line_id as SellListLineId,
      itemTitle: line.item_title,
      status: remainingQuantity > 0 ? "partial" : "completed",
      action:
        acceptedOfferIds.length > 0 && listingId
          ? "mixed"
          : acceptedOfferIds.length > 0
            ? readinessAction === "selected-offer"
              ? "accepted-offer"
              : "accepted-smart-match"
            : "published-listing",
      quantity: line.quantity,
      remainingQuantity,
      detail:
        remainingQuantity > 0
          ? t("checkout.routes.sellCheckoutSession.confirmation.line.partial", { itemTitle: line.item_title })
          : t("checkout.routes.sellCheckoutSession.confirmation.line.completed", { itemTitle: line.item_title }),
      references: {
        ...(acceptedOfferIds.length > 0 ? { offerIds: acceptedOfferIds } : {}),
        ...(listingId ? { listingId } : {}),
      },
    });
  }

  return {
    completedLineIds,
    remainingLineQuantities,
    writeResults,
    summary: {
      acceptedOfferCount,
      publishedListingCount,
      skippedLineCount: 0,
      skippedReasons: [],
      lineOutcomes,
      sideEffects: sideEffectsForMarketplaceHandoff(acceptedOfferCount, publishedListingCount),
    },
  };
}
