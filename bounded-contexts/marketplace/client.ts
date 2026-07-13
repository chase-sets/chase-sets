import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, type ListResponse } from "@chase-sets/http/responses";
import type { buildMarketplaceApi } from "./api";

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
  MarketplaceListingListItem,
  MarketplaceSellerListingAvailability,
  MarketplaceSellerListingStatusCounts,
  MarketplaceListingTermsPreview,
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
  OfferBuyerMute,
  MarketplaceOffer,
  PublicOfferDetail,
  SubmittedOfferDetail,
  SubmittedOfferListItem,
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
  MarketplaceListingListItem,
  MarketplaceSellerListingAvailability,
  MarketplaceSellerListingStatusCounts,
  MarketplaceListingTermsPreview,
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
  OfferBuyerMute,
  PublicOfferDetail,
  SubmittedOfferDetail,
  SubmittedOfferListItem,
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

  return {
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
      body: Record<string, unknown>,
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
    async disableSellerListingAvailability(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.account["listing-availability"].disable.$post({
          json: body,
          header: headers,
        }),
      );
    },
    async enableSellerListingAvailability() {
      return parseJsonResponse(
        await client.account["listing-availability"].enable.$post({
          json: {},
          header: headers,
        }),
      );
    },
    async scheduleSellerAwayWindow(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.account["listing-availability"]["away-window"].$post({
          json: body,
          header: headers,
        }),
      );
    },
    async cancelScheduledAwayWindow() {
      return parseJsonResponse(
        await client.account["listing-availability"]["away-window"].$delete({
          header: headers,
        }),
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
    async createListing(body: Record<string, unknown>, options: Readonly<{ signal?: AbortSignal }> = {}) {
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, "/account/listings"), {
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
      body: Record<string, unknown>,
      options: Readonly<{ signal?: AbortSignal }> = {},
    ) {
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, `/account/listings/${encodeURIComponent(id)}/price`), {
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
    async applyBulkListingPriceUpdates(
      body: Readonly<{ updates: readonly MarketplaceBulkListingPriceUpdateInput[] }>,
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
    async updateListingQuantityCap(id: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.account.listings[":id"]["quantity-cap"].$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async updateListingPurchaseLimits(id: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.account.listings[":id"]["purchase-limits"].$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async publishListing(id: string, body: Record<string, unknown> = {}) {
      return parseJsonResponse(
        await client.account.listings[":id"].publish.$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async pauseListing(id: string) {
      return parseJsonResponse(
        await client.account.listings[":id"].pause.$post({
          param: { id },
          json: {},
          header: headers,
        }),
      );
    },
    async withdrawListing(id: string) {
      return parseJsonResponse(
        await client.account.listings[":id"].withdraw.$post({
          param: { id },
          json: {},
          header: headers,
        }),
      );
    },
    async listSubmittedOffers(query = ""): Promise<ListResponse<SubmittedOfferListItem>> {
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
    async createSubmittedOffer(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.account.offers.submitted.$post({
          json: body,
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
    async listOfferBuyerMutes(): Promise<ListResponse<OfferBuyerMute>> {
      return parseJsonResponse(
        await client.account.offers.mutes.$get({
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
    async acceptOfferMatch(id: string, body: Record<string, unknown> = {}) {
      return parseJsonResponse(
        await client.account.offers.matches[":id"].accept.$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async declineOfferMatch(id: string) {
      return parseJsonResponse(
        await client.account.offers.matches[":id"].decline.$post({
          param: { id },
          json: {},
          header: headers,
        }),
      );
    },
    async muteOfferBuyer(id: string) {
      return parseJsonResponse(
        await client.account.offers.matches[":id"]["mute-buyer"].$post({
          param: { id },
          json: {},
          header: headers,
        }),
      );
    },
    async unmuteOfferBuyer(listingId: string, buyerAccountId: string) {
      return parseJsonResponse(
        await client.account.offers.mutes[":listingId"][":buyerAccountId"].unmute.$post({
          param: { listingId, buyerAccountId },
          json: {},
          header: headers,
        }),
      );
    },
  };
}

export const marketplaceApi = createMarketplaceApiClient();
