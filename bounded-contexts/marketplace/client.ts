import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, type ListResponse } from "@chase-sets/http/responses";
import type { buildMarketplaceApi } from "./api";
import type { BuyerOfferPolicyRequest } from "./features/offer-policy/domain/contracts";
import type { serializeBuyerOfferPolicy } from "./features/offer-policy/api/runtime";
export type { MarketplaceMutationRecoveryResult } from "./features/mutation-recovery/domain/contracts";
import { recoverMarketplaceCommand, MarketplaceCommandRecoveryError } from "./features/mutation-recovery/api/client";
import type {
  MarketplaceListingMutationKind,
  MarketplaceMutationKind,
} from "./features/mutation-recovery/domain/contracts";
export { MarketplaceCommandRecoveryError } from "./features/mutation-recovery/api/client";
export type BuyerOfferPolicySnapshot = ReturnType<typeof serializeBuyerOfferPolicy>;
export type { BuyerOfferPolicyRequest, BuyerOfferPolicyTerms } from "./features/offer-policy/domain/contracts";

export { evidenceCoverageCodeLocaleKey } from "./features/listings/domain/evidence-coverage";
export type {
  EvidenceCoverageCode,
  EvidenceCoverageResult,
  EvidenceSlotCoverage,
} from "./features/listings/domain/evidence-coverage";

export type {
  MarketplaceBulkListingPriceUpdateInput,
  MarketplaceBulkListingPriceUpdateOutcome,
  MarketplaceItemListing,
  MarketplaceListingDetail,
  MarketplaceListingEvidenceReadiness,
  MarketplaceListingFeeLockReportEntry,
  MarketplaceListingFeeHistoryEntry,
  MarketplaceListingInventoryItemOption,
  MarketplaceAnonymousListingDraftIntent,
  MarketplaceAnonymousListingDraftInput,
  MarketplaceCreateListingInput,
  MarketplaceListingAttemptInput,
  MarketplaceListingListItem,
  MarketplaceSellerListingAvailability,
  MarketplaceSellerOrderCapacity,
  MarketplaceSellerListingStatusCounts,
  MarketplaceListingTermsPreview,
  MarketplaceUpdateListingPriceInput,
  MarketplacePublicStandardTermsPreview,
  MarketplaceMarketSummary,
  MarketplaceListingEvidenceCoverage,
} from "./features/listings/api/contracts";
export type {
  MarketplaceReportSubmissionSnapshot,
  MarketplaceReviewReportSubmissionSnapshot,
  ReportListingRequest,
  ReportReviewRequest,
} from "./features/reports/api/contracts";
export type {
  OfferMatchDetail,
  OfferMatchListItem,
  MarketplaceOffer,
  PublicOfferDetail,
  SubmittedOfferDetail,
  SubmittedOfferLifecycleAction,
  SubmittedOfferLifecycleOutcome,
  SubmittedOfferListItem,
  SubmittedOfferStatus,
  SubmittedOfferStatusCounts,
  SubmittedOfferStatusFilter,
} from "./features/offers/api/contracts";

import type {
  MarketplaceBulkListingPriceUpdateInput,
  MarketplaceBulkListingPriceUpdateOutcome,
  MarketplaceItemListing,
  MarketplaceListingDetail,
  MarketplaceListingEvidenceReadiness,
  MarketplaceListingFeeLockReportEntry,
  MarketplaceListingFeeHistoryEntry,
  MarketplaceListingInventoryItemOption,
  MarketplaceAnonymousListingDraftIntent,
  MarketplaceAnonymousListingDraftInput,
  MarketplaceCreateListingInput,
  MarketplaceListingAttemptInput,
  MarketplaceListingListItem,
  MarketplaceSellerListingAvailability,
  MarketplaceSellerOrderCapacity,
  MarketplaceSellerListingStatusCounts,
  MarketplaceListingTermsPreview,
  MarketplaceUpdateListingPriceInput,
  MarketplacePublicStandardTermsPreview,
  MarketplaceMarketSummary,
  MarketplaceListingEvidenceCoverage,
} from "./features/listings/api/contracts";
import type {
  MarketplaceReportSubmissionSnapshot,
  MarketplaceReviewReportSubmissionSnapshot,
  ReportListingRequest,
  ReportReviewRequest,
} from "./features/reports/api/contracts";
import type {
  OfferMatchDetail,
  OfferMatchListItem,
  PublicOfferDetail,
  SubmittedOfferDetail,
  SubmittedOfferLifecycleAction,
  SubmittedOfferLifecycleOutcome,
  SubmittedOfferListItem,
  SubmittedOfferStatus,
  SubmittedOfferStatusCounts,
  SubmittedOfferStatusFilter,
} from "./features/offers/api/contracts";

type MarketplaceApiApp = ReturnType<typeof buildMarketplaceApi>;

const DEFAULT_BASE_URL = "/api/marketplace";

export class MarketplaceApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(marketplaceApiErrorMessage(status, body));
  }
}

function isDefiniteMarketplaceCommandResponse(error: unknown): boolean {
  if (!(error instanceof MarketplaceApiError) || error.status >= 500) return false;
  const body = error.body;
  return !(
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "code" in body.error &&
    body.error.code === "history_incomplete"
  );
}

export interface MarketplaceApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  return Object.fromEntries(new Headers(headers).entries());
}

function queryFromString(query: string) {
  const params = new URLSearchParams(query);
  return Object.fromEntries(params.entries());
}

function marketplaceApiErrorMessage(status: number, body: unknown) {
  if (!body || typeof body !== "object" || !("error" in body)) {
    return `API error ${status}`;
  }

  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return String(error ?? `API error ${status}`);
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && message.trim()) {
    return message;
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.trim()) {
    return code;
  }

  return `API error ${status}`;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new MarketplaceApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

/** The purchase limits a Listing route parses from this body, so the client hash matches the server's canonical request. */
function listingPurchaseLimits(value: unknown) {
  if (value === null || value === undefined) return null;
  const source = value as Record<string, unknown>;
  const limit = (raw: unknown) => (raw === null || raw === undefined || raw === "" ? null : Number(raw));
  return {
    maxUnitsPerOrder: limit(source.maxUnitsPerOrder ?? source.max_units_per_order),
    maxUnitsPerDay: limit(source.maxUnitsPerDay ?? source.max_units_per_day),
    maxUnitsPerCustomerAccount: limit(source.maxUnitsPerCustomerAccount ?? source.max_units_per_customer_account),
  };
}

function joinApiPath(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function createMarketplaceApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: MarketplaceApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = honoClientResource(
    hc<MarketplaceApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);
  const lookupAttempt = async (attemptId: string, kind: MarketplaceMutationKind, target: string, requestHash: string) =>
    parseJsonResponse(
      await configuredFetch(
        joinApiPath(
          baseUrl,
          `/mutation-attempts/${encodeURIComponent(attemptId)}?${new URLSearchParams({ kind, target, requestHash })}`,
        ),
        { headers },
      ),
    );

  // Sends a Listing command once; on transport loss it issues one owner lookup and never resends.
  const recoverListingCommand = <T>(
    mutationKind: MarketplaceListingMutationKind,
    target: string | null,
    attempt: MarketplaceListingAttemptInput,
    request: Record<string, unknown>,
    send: () => Promise<T>,
  ) =>
    recoverMarketplaceCommand({
      attemptId: attempt.idempotencyKey,
      mutationKind,
      target,
      request,
      isCommandResponse: isDefiniteMarketplaceCommandResponse,
      lookup: (requestHash) => lookupAttempt(attempt.idempotencyKey, mutationKind, target ?? "self", requestHash),
      send,
    });
  const attemptHeaders = (attempt: MarketplaceListingAttemptInput) => ({
    ...headersToRecord(headers),
    "Idempotency-Key": attempt.idempotencyKey,
    ...(attempt.requestHash ? { "Chase-Sets-Request-Hash": attempt.requestHash } : {}),
  });

  return {
    async listBuyerOfferPolicies(
      offerIds: readonly string[] = [],
    ): Promise<{ items: BuyerOfferPolicySnapshot[]; nextCursor: string | null }> {
      const query = new URLSearchParams();
      for (const offerId of offerIds) query.append("offerId", offerId);
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, `/account/offer-policies?${query}`), { headers }),
      );
    },
    async getBuyerOfferPolicy(policyId: string): Promise<BuyerOfferPolicySnapshot> {
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, `/account/offer-policies/${encodeURIComponent(policyId)}`), {
          headers,
        }),
      );
    },
    async commandBuyerOfferPolicy(
      policyId: string,
      command: BuyerOfferPolicyRequest,
    ): Promise<BuyerOfferPolicySnapshot> {
      const { attemptId, ...request } = command;
      const result = await recoverMarketplaceCommand<BuyerOfferPolicySnapshot>({
        attemptId,
        mutationKind: "offer-policy.command",
        target: policyId,
        request,
        isCommandResponse: isDefiniteMarketplaceCommandResponse,
        lookup: (requestHash) => lookupAttempt(attemptId, "offer-policy.command", policyId, requestHash),
        resolveReceipt: async (receipt) => {
          const snapshot = await parseJsonResponse<BuyerOfferPolicySnapshot>(
            await configuredFetch(joinApiPath(baseUrl, `/account/offer-policies/${encodeURIComponent(policyId)}`), {
              headers,
            }),
          );
          if (snapshot.version !== receipt.version) throw new MarketplaceCommandRecoveryError("ambiguous");
          return snapshot;
        },
        send: async () =>
          parseJsonResponse<BuyerOfferPolicySnapshot>(
            await configuredFetch(
              joinApiPath(baseUrl, `/account/offer-policies/${encodeURIComponent(policyId)}/commands`),
              {
                method: "POST",
                headers: { ...headersToRecord(headers), "content-type": "application/json" },
                body: JSON.stringify(command),
              },
            ),
          ),
      });
      if (!("policyId" in result)) throw new MarketplaceCommandRecoveryError("ambiguous");
      return result;
    },
    async getMarketSummary(productId: string): Promise<MarketplaceMarketSummary> {
      return parseJsonResponse(
        await client["products"][":productId"]["market-summary"].$get({
          param: { productId },
          header: headers,
        }),
      );
    },
    async listItemListings(productId: string): Promise<ListResponse<MarketplaceItemListing>> {
      return parseJsonResponse(
        await client["products"][":productId"].listings.$get({
          param: { productId },
          header: headers,
        }),
      );
    },
    async previewPublicStandardListingTerms(
      body: Record<string, unknown>,
      options: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<MarketplacePublicStandardTermsPreview> {
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, "/terms/public-standard/listing-preview"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
          },
          body: JSON.stringify(body),
          signal: options.signal,
        }),
      );
    },
    async createAnonymousListingDraftIntent(
      anonymousOwnerId: string,
      body: MarketplaceAnonymousListingDraftInput,
      options: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<MarketplaceAnonymousListingDraftIntent> {
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, "/guest/listing-draft-intents"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
            "x-marketplace-anonymous-listing-draft-id": anonymousOwnerId,
          },
          body: JSON.stringify(body),
          signal: options.signal,
        }),
      );
    },
    async reportListing(
      listingId: string,
      anonymousReporterId: string | null,
      body: ReportListingRequest,
    ): Promise<MarketplaceReportSubmissionSnapshot> {
      return parseJsonResponse(
        await client.listings[":id"].report.$post({
          param: { id: listingId },
          json: body,
          header: {
            ...headersToRecord(headers),
            ...(anonymousReporterId ? { "x-marketplace-anonymous-report-id": anonymousReporterId } : {}),
          },
        }),
      );
    },
    async reportReview(
      reviewId: string,
      body: ReportReviewRequest,
    ): Promise<MarketplaceReviewReportSubmissionSnapshot> {
      return parseJsonResponse(
        await client.reviews[":id"].report.$post({
          param: { id: reviewId },
          json: body,
          header: headers,
        }),
      );
    },
    async listSellerListings(query = ""): Promise<
      ListResponse<MarketplaceListingListItem> & {
        limit: number;
        offset: number;
        statusCounts: MarketplaceSellerListingStatusCounts;
      }
    > {
      return parseJsonResponse(
        await client.account.listings.$get({
          query: queryFromString(query),
          header: headers,
        }),
      );
    },
    async listSellerListingInventory(query = ""): Promise<ListResponse<MarketplaceListingInventoryItemOption>> {
      return parseJsonResponse(
        await client.account["listing-inventory"].$get({
          query: queryFromString(query),
          header: headers,
        }),
      );
    },
    async hasSellerSupplyLocationNamed(name: string): Promise<boolean> {
      const response = await client.account["supply-locations"].exists.$get({
        query: { name },
        header: headers,
      });
      const body = await parseJsonResponse<{ exists: boolean }>(response);
      return body.exists;
    },
    async getSellerListingAvailability(): Promise<MarketplaceSellerListingAvailability> {
      return parseJsonResponse(
        await client.account["listing-availability"].$get({
          header: headers,
        }),
      );
    },
    async disableSellerListingAvailability(
      body: MarketplaceListingAttemptInput &
        Readonly<{
          reasonCategory?: string | null;
          availableAgainOn?: string | null;
          availableAgainAt?: string | null;
        }>,
    ) {
      return recoverListingCommand(
        "seller.availability",
        null,
        body,
        {
          status: "unavailable",
          reasonCategory: body.reasonCategory || null,
          availableAgainOn: body.availableAgainOn || null,
          availableAgainAt: body.availableAgainAt || null,
        },
        async () =>
          parseJsonResponse(
            await client.account["listing-availability"].disable.$post({
              json: body,
              header: headers,
            }),
          ),
      );
    },
    async enableSellerListingAvailability(attempt: MarketplaceListingAttemptInput) {
      return recoverListingCommand("seller.availability", null, attempt, { status: "available" }, async () =>
        parseJsonResponse(
          await client.account["listing-availability"].enable.$post({
            json: attempt,
            header: headers,
          }),
        ),
      );
    },
    async scheduleSellerAwayWindow(
      body: MarketplaceListingAttemptInput &
        Readonly<{ startsAt: string; endsAt: string | null; reasonCategory: string }>,
    ) {
      return recoverListingCommand(
        "seller.away",
        null,
        body,
        { action: "schedule", startsAt: body.startsAt, endsAt: body.endsAt, reasonCategory: body.reasonCategory },
        async () =>
          parseJsonResponse(
            await client.account["listing-availability"]["away-window"].$post({
              json: body,
              header: headers,
            }),
          ),
      );
    },
    async cancelScheduledAwayWindow(attempt: MarketplaceListingAttemptInput) {
      return recoverListingCommand("seller.away", null, attempt, { action: "cancel" }, async () =>
        parseJsonResponse(
          await configuredFetch(joinApiPath(baseUrl, "/account/listing-availability/away-window"), {
            method: "DELETE",
            headers: attemptHeaders(attempt),
          }),
        ),
      );
    },
    async getSellerOrderCapacity(): Promise<MarketplaceSellerOrderCapacity> {
      return parseJsonResponse(
        await client.account["order-capacity"].$get({
          header: headers,
        }),
      );
    },
    async setSellerOrderCapacity(maxOpenOrders: number, attempt: MarketplaceListingAttemptInput) {
      return recoverListingCommand("seller.order-capacity", null, attempt, { maxOpenOrders }, async () =>
        parseJsonResponse(
          await client.account["order-capacity"].$post({
            json: { maxOpenOrders, ...attempt },
            header: headers,
          }),
        ),
      );
    },
    async clearSellerOrderCapacity(attempt: MarketplaceListingAttemptInput) {
      return recoverListingCommand("seller.order-capacity", null, attempt, { maxOpenOrders: null }, async () =>
        parseJsonResponse(
          await configuredFetch(joinApiPath(baseUrl, "/account/order-capacity"), {
            method: "DELETE",
            headers: attemptHeaders(attempt),
          }),
        ),
      );
    },
    async claimAnonymousListingDraftIntent(
      anonymousOwnerId: string,
      intentId: string,
    ): Promise<MarketplaceAnonymousListingDraftIntent> {
      return parseJsonResponse(
        await configuredFetch(
          joinApiPath(baseUrl, `/account/listing-draft-intents/${encodeURIComponent(intentId)}/claim`),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...headersToRecord(headers),
              "x-marketplace-anonymous-listing-draft-id": anonymousOwnerId,
            },
            body: JSON.stringify({}),
          },
        ),
      );
    },
    async getSellerListing(id: string): Promise<MarketplaceListingDetail> {
      return parseJsonResponse(
        await client.account.listings[":id"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async getSellerListingEvidenceCoverage(id: string, now?: string): Promise<MarketplaceListingEvidenceCoverage> {
      const query = now ? `?now=${encodeURIComponent(now)}` : "";
      return parseJsonResponse(
        await configuredFetch(
          joinApiPath(baseUrl, `/account/listings/${encodeURIComponent(id)}/evidence-coverage${query}`),
          { headers },
        ),
      );
    },
    async getSellerListingFeeHistory(
      id: string,
    ): Promise<{ items: MarketplaceListingFeeHistoryEntry[]; total: number; count: number }> {
      return parseJsonResponse(
        await client.account.listings[":id"]["fee-history"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async listSellerListingFeeLockReport(query = ""): Promise<ListResponse<MarketplaceListingFeeLockReportEntry>> {
      return parseJsonResponse(
        await client.account.listings["fee-lock-report"].$get({
          query: queryFromString(query),
          header: headers,
        }),
      );
    },
    async createListing(body: MarketplaceCreateListingInput, options: Readonly<{ signal?: AbortSignal }> = {}) {
      return recoverListingCommand("listing.create", body.inventoryItemId, body, { ...body }, async () =>
        parseJsonResponse(
          await configuredFetch(joinApiPath(baseUrl, "/account/listings"), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...headersToRecord(headers),
            },
            body: JSON.stringify(body),
            signal: options.signal,
          }),
        ),
      );
    },
    async createListingWithPhotos(formData: FormData) {
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, "/account/listings"), {
          method: "POST",
          headers,
          body: formData,
        }),
      );
    },
    async addListingPhotos(id: string, formData: FormData) {
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, `/account/listings/${encodeURIComponent(id)}/photos`), {
          method: "POST",
          headers,
          body: formData,
        }),
      );
    },
    async updateListingPhotoClassification(id: string, photoId: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await configuredFetch(
          joinApiPath(
            baseUrl,
            `/account/listings/${encodeURIComponent(id)}/photos/${encodeURIComponent(photoId)}/classify`,
          ),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...headersToRecord(headers),
            },
            body: JSON.stringify(body),
          },
        ),
      );
    },
    async replaceListingPhoto(id: string, photoId: string, formData: FormData) {
      return parseJsonResponse(
        await configuredFetch(
          joinApiPath(
            baseUrl,
            `/account/listings/${encodeURIComponent(id)}/photos/${encodeURIComponent(photoId)}/replace`,
          ),
          {
            method: "POST",
            headers,
            body: formData,
          },
        ),
      );
    },
    async removeListingPhoto(id: string, photoId: string) {
      return parseJsonResponse(
        await configuredFetch(
          joinApiPath(baseUrl, `/account/listings/${encodeURIComponent(id)}/photos/${encodeURIComponent(photoId)}`),
          { method: "DELETE", headers },
        ),
      );
    },
    async reorderListingPhotos(id: string, orderedPhotoIds: readonly string[]) {
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, `/account/listings/${encodeURIComponent(id)}/photos/reorder`), {
          method: "POST",
          headers: { "content-type": "application/json", ...headersToRecord(headers) },
          body: JSON.stringify({ orderedPhotoIds }),
        }),
      );
    },
    async previewListingTerms(
      body: Record<string, unknown>,
      options: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<MarketplaceListingTermsPreview> {
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, "/account/listings/preview"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
          },
          body: JSON.stringify(body),
          signal: options.signal,
        }),
      );
    },
    async previewListingEvidenceReadiness(
      body: Record<string, unknown>,
      options: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<MarketplaceListingEvidenceReadiness> {
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, "/account/listings/evidence-readiness/preview"), {
          method: "POST",
          headers: { "content-type": "application/json", ...headersToRecord(headers) },
          body: JSON.stringify(body),
          signal: options.signal,
        }),
      );
    },
    async updateListingPrice(
      id: string,
      body: MarketplaceUpdateListingPriceInput,
      options: Readonly<{ signal?: AbortSignal }> = {},
    ) {
      return recoverListingCommand(
        "listing.update-price",
        id,
        body,
        { listingId: id, priceAmount: body.priceAmount, priceCurrencyCode: body.priceCurrencyCode },
        async () =>
          parseJsonResponse(
            await configuredFetch(joinApiPath(baseUrl, `/account/listings/${encodeURIComponent(id)}/price`), {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...headersToRecord(headers),
              },
              body: JSON.stringify(body),
              signal: options.signal,
            }),
          ),
      );
    },
    /** One batch id; each target's attempt is that id bound to its Listing, so a retry re-runs only unknown targets. */
    async applyBulkListingPriceUpdates(
      body: Readonly<{ batchId: string; updates: readonly MarketplaceBulkListingPriceUpdateInput[] }>,
      options: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<ListResponse<MarketplaceBulkListingPriceUpdateOutcome>> {
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, "/account/listings/prices/bulk"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
          },
          body: JSON.stringify(body),
          signal: options.signal,
        }),
      );
    },
    async updateListingQuantityCap(
      id: string,
      body: MarketplaceListingAttemptInput &
        Readonly<{ quantityCap: number; purchaseLimits?: unknown }> &
        Record<string, unknown>,
    ) {
      return recoverListingCommand(
        "listing.update-quantity",
        id,
        body,
        {
          listingId: id,
          quantityCap: Number(body.quantityCap ?? 0),
          purchaseLimits: listingPurchaseLimits(body.purchaseLimits),
        },
        async () =>
          parseJsonResponse(
            await client.account.listings[":id"]["quantity-cap"].$post({
              param: { id },
              json: body,
              header: headers,
            }),
          ),
      );
    },
    async updateListingPurchaseLimits(id: string, body: MarketplaceListingAttemptInput & Record<string, unknown>) {
      return recoverListingCommand(
        "listing.update-purchase-limits",
        id,
        body,
        { listingId: id, purchaseLimits: listingPurchaseLimits(body.purchaseLimits ?? body) },
        async () =>
          parseJsonResponse(
            await client.account.listings[":id"]["purchase-limits"].$post({
              param: { id },
              json: body,
              header: headers,
            }),
          ),
      );
    },
    async publishListing(
      id: string,
      body: MarketplaceListingAttemptInput & Readonly<{ feeQuoteFingerprint?: string | null }>,
    ) {
      return recoverListingCommand("listing.publish", id, body, { listingId: id }, async () =>
        parseJsonResponse(
          await client.account.listings[":id"].publish.$post({
            param: { id },
            json: body,
            header: headers,
          }),
        ),
      );
    },
    async pauseListing(id: string, attempt: MarketplaceListingAttemptInput) {
      return recoverListingCommand("listing.pause", id, attempt, { listingId: id, reason: "seller" }, async () =>
        parseJsonResponse(
          await client.account.listings[":id"].pause.$post({
            param: { id },
            json: attempt,
            header: headers,
          }),
        ),
      );
    },
    async withdrawListing(id: string, attempt: MarketplaceListingAttemptInput) {
      return recoverListingCommand("listing.withdraw", id, attempt, { listingId: id }, async () =>
        parseJsonResponse(
          await client.account.listings[":id"].withdraw.$post({
            param: { id },
            json: attempt,
            header: headers,
          }),
        ),
      );
    },
    async listSubmittedOffers(
      query = "",
    ): Promise<ListResponse<SubmittedOfferListItem> & { statusCounts?: SubmittedOfferStatusCounts }> {
      return parseJsonResponse(
        await client.account.offers.submitted.$get({
          query: queryFromString(query),
          header: headers,
        }),
      );
    },
    async getSubmittedOffer(id: string): Promise<SubmittedOfferDetail> {
      return parseJsonResponse(
        await client.account.offers.submitted[":id"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async createSubmittedOffer(body: Record<string, unknown> & { attemptId: string }): Promise<unknown> {
      return recoverMarketplaceCommand({
        attemptId: body.attemptId,
        mutationKind: "offer.submit",
        target: String(body.productId),
        request: body,
        isCommandResponse: isDefiniteMarketplaceCommandResponse,
        lookup: (requestHash) => lookupAttempt(body.attemptId, "offer.submit", String(body.productId), requestHash),
        send: async () =>
          parseJsonResponse(
            await client.account.offers.submitted.$post({
              json: body,
              header: headers,
            }),
          ),
      });
    },
    async updateSubmittedOfferPrice(id: string, body: Record<string, unknown> & { attemptId: string }) {
      return recoverMarketplaceCommand({
        attemptId: body.attemptId,
        mutationKind: "offer.update-price",
        target: id,
        request: { ...body, offerId: id },
        isCommandResponse: isDefiniteMarketplaceCommandResponse,
        lookup: (requestHash) => lookupAttempt(body.attemptId, "offer.update-price", id, requestHash),
        send: async () =>
          parseJsonResponse(
            await client.account.offers.submitted[":id"].price.$patch({
              param: { id },
              json: body,
              header: headers,
            }),
          ),
      });
    },
    async changeSubmittedOfferLifecycle(
      id: string,
      action: SubmittedOfferLifecycleAction,
    ): Promise<{ id: string; version: number; status: string; outcome: "changed" | "unchanged" }> {
      return parseJsonResponse(
        await client.account.offers.submitted[":id"][action].$post({
          param: { id },
          json: {},
          header: headers,
        }),
      );
    },
    async bulkChangeSubmittedOfferLifecycle(
      action: SubmittedOfferLifecycleAction,
      offerIds: readonly string[],
    ): Promise<ListResponse<SubmittedOfferLifecycleOutcome>> {
      return parseJsonResponse(
        await client.account.offers.submitted.bulk.$post({
          json: { action, offerIds },
          header: headers,
        }),
      );
    },
    async listOfferMatches(query = ""): Promise<ListResponse<OfferMatchListItem>> {
      return parseJsonResponse(
        await client.account.offers.matches.$get({
          query: queryFromString(query),
          header: headers,
        }),
      );
    },
    async getOfferMatch(id: string): Promise<OfferMatchDetail> {
      return parseJsonResponse(
        await client.account.offers.matches[":id"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async getPublicOffer(id: string): Promise<PublicOfferDetail> {
      return parseJsonResponse(
        await client.account.offers.public[":id"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async previewOfferAcceptanceTerms(id: string, listingId: string): Promise<MarketplaceListingTermsPreview> {
      return parseJsonResponse(
        await client.account.offers.matches[":id"]["terms-preview"].$get({
          param: { id },
          query: { listingId },
          header: headers,
        }),
      );
    },
    async acceptOfferMatch(id: string, body: Record<string, unknown> & { sourceActionKey: string }) {
      return recoverMarketplaceCommand({
        attemptId: body.sourceActionKey,
        mutationKind: "offer.accept",
        target: id,
        request: { ...body, offerId: id },
        isCommandResponse: isDefiniteMarketplaceCommandResponse,
        lookup: (requestHash) => lookupAttempt(body.sourceActionKey, "offer.accept", id, requestHash),
        send: async () =>
          parseJsonResponse(
            await client.account.offers.matches[":id"].accept.$post({
              param: { id },
              json: body,
              header: headers,
            }),
          ),
      });
    },
    async declineOfferMatch(id: string, body: { attemptId: string }) {
      return recoverMarketplaceCommand({
        attemptId: body.attemptId,
        mutationKind: "offer.decline",
        target: id,
        request: { offerId: id },
        isCommandResponse: isDefiniteMarketplaceCommandResponse,
        lookup: (requestHash) => lookupAttempt(body.attemptId, "offer.decline", id, requestHash),
        send: async () =>
          parseJsonResponse(
            await client.account.offers.matches[":id"].decline.$post({
              param: { id },
              json: body,
              header: headers,
            }),
          ),
      });
    },
  };
}

export const marketplaceApi = createMarketplaceApiClient();
