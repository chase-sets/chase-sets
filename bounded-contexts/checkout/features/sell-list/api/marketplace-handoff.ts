import { t } from "@chase-sets/localization";
import { createHash } from "node:crypto";
import { createPostWriteTokenPayloadFromSources, type CommandReceiptMetadata } from "@chase-sets/http/responses";
import type { SellListLineId } from "../../../support/runtime-support/common";
import {
  MarketplaceApiError,
  hashMarketplaceRequest,
  marketplaceOfferCanonicalRequest,
} from "@chase-sets/marketplace/server";
import type { SellListConfirmationSummary } from "../domain/domain";
import { reviewedListingId } from "./reviewed-lines";
import {
  staleManagedOfferReviewError,
  staleReviewPlanError,
  type MarketplaceRequestApiClient,
  type SellListMarketplaceHandoff,
  type SellListReviewedLine,
} from "./handoff-contracts";
function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function marketplaceSourceReceipts(
  writeResults: readonly unknown[],
): readonly { commandReceipt: CommandReceiptMetadata }[] {
  const receipt = createPostWriteTokenPayloadFromSources(writeResults)?.receipt;
  return receipt
    ? [
        {
          commandReceipt: {
            mode: "eventual",
            commitPosition: receipt.commitPosition,
            commitEventIds: receipt.sources.flatMap((source) => source.eventIds),
            commitPositions: receipt.sources,
          },
        },
      ]
    : [];
}
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
  "offer_not_open",
  "listing_evidence_incomplete",
  "listing_seller_trust_incomplete",
  "listing_not_eligible",
  "managed_offer_held",
  "managed_offer_refresh_required",
  "managed_offer_conflict",
]);

/** Exact replay is answered by Marketplace's consumed key, never by Offer status. */
async function acceptOfferMatchWithRecovery(
  marketplaceApi: MarketplaceRequestApiClient,
  offerId: string,
  itemTitle: string,
  body: Parameters<MarketplaceRequestApiClient["acceptOfferMatch"]>[1],
  sellerAccountId: string,
): Promise<unknown | null> {
  try {
    const result = await marketplaceApi.acceptOfferMatch(offerId, body);
    const consumed = await marketplaceApi.getOfferAcceptanceAttempt(offerId, body);
    if (
      consumed.ownerStatus !== "committed" ||
      consumed.mutationKind !== "offer.accept" ||
      consumed.actorBinding.accountId !== sellerAccountId ||
      consumed.target.kind !== "offer" ||
      consumed.target.id !== offerId ||
      consumed.attemptKeyFingerprint !== createHash("sha256").update(body.sourceActionKey).digest("hex") ||
      consumed.canonicalRequestHash !==
        hashMarketplaceRequest(marketplaceOfferCanonicalRequest("offer.accept", { ...body, offerId })) ||
      consumed.ownerReceipt?.id !== offerId
    ) {
      throw new MarketplaceApiError(409, { error: { code: "offer_already_accepted" } });
    }
    return result;
  } catch (error) {
    const code = marketplaceErrorCode(error);
    if (OFFER_ACCEPTANCE_STALE_CODES.has(code)) {
      if (
        code === "managed_offer_held" ||
        code === "managed_offer_refresh_required" ||
        code === "managed_offer_conflict"
      ) {
        throw staleManagedOfferReviewError(itemTitle);
      }
      throw staleReviewPlanError(itemTitle);
    }
    throw error;
  }
}

export type SellListHandoffLineResult = Readonly<{
  lineId: string;
  status: "completed" | "partial" | "skipped" | "conflict" | "ambiguous" | "not-attempted";
  detail: string;
}>;
export class SellListHandoffInterruptedError extends Error {
  constructor(
    public readonly reason: unknown,
    public readonly lines: readonly SellListHandoffLineResult[],
  ) {
    super(reason instanceof Error ? reason.message : "Sell List handoff interrupted.");
  }
}

export async function performMarketplaceHandoff(
  marketplaceApi: MarketplaceRequestApiClient,
  confirmationId: string,
  reviewedLines: readonly SellListReviewedLine[],
  sellerAccountId: string = reviewedLines[0]?.line.seller_account_id ?? "",
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
    try {
      if (readinessAction === "selected-offer" && review.selectedOffer) {
        const result = await acceptOfferMatchWithRecovery(
          marketplaceApi,
          review.selectedOffer.offerId,
          line.item_title,
          {
            listingId: review.selectedOffer.listingId,
            feeQuoteFingerprint: review.selectedOffer.feeQuoteFingerprint,
            sourceActionKey: `sell-confirm:${confirmationId}:${line.line_id}:selected:${review.selectedOffer.offerId}`,
          },
          sellerAccountId,
        );
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
          const result = await acceptOfferMatchWithRecovery(
            marketplaceApi,
            target.offerId,
            line.item_title,
            {
              listingId: target.listingId,
              feeQuoteFingerprint: target.feeQuoteFingerprint,
              sourceActionKey: `sell-confirm:${confirmationId}:${line.line_id}:match:${target.offerId}`,
              acceptanceBatchId,
              acceptanceBatchSize: review.productOfferTargets.length,
            },
            sellerAccountId,
          );
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
          idempotencyKey: createHash("sha256")
            .update(JSON.stringify(["sell-confirm", confirmationId, line.line_id, "create"]))
            .digest("hex"),
          inventoryItemId: review.fallbackListing.inventoryItemId,
          priceAmount: review.fallbackListing.priceAmount,
          priceCurrencyCode: review.fallbackListing.priceCurrencyCode,
          quantityCap: review.fallbackListing.quantityCap,
          listingIdOverride,
        });
        writeResults.push(createdListing);
        listingId = responseString(createdListing, "id", "listingId", "listing_id") || listingIdOverride;
        try {
          const result = await marketplaceApi.publishListing(listingId, {
            idempotencyKey: createHash("sha256")
              .update(JSON.stringify(["sell-confirm", confirmationId, line.line_id, "publish"]))
              .digest("hex"),
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
    } catch (error) {
      throw new SellListHandoffInterruptedError(error, [
        ...lineOutcomes.map((outcome) => ({ lineId: outcome.lineId, status: outcome.status, detail: outcome.detail })),
        {
          lineId: line.line_id,
          status: marketplaceErrorCode(error) === "offer_already_accepted" ? "conflict" : "ambiguous",
          detail: error instanceof Error ? error.message : "Handoff interrupted.",
        },
        ...reviewedLines.slice(lineOutcomes.length + 1).map(({ line: pending }) => ({
          lineId: pending.line_id,
          status: "not-attempted" as const,
          detail: "Not attempted.",
        })),
      ]);
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
