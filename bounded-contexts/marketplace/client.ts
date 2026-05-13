import { hc } from "hono/client";
import type { HonoClientResource } from "@chase-sets/http/hono-client";
import type { ListResponse } from "@chase-sets/http/responses";
import type { buildMarketplaceApi } from "./api";

export type {
  MarketplaceItemListing,
  MarketplaceListingDetail,
  MarketplaceListingFeeLockReportEntry,
  MarketplaceListingFeeHistoryEntry,
  MarketplaceListingInventoryItemOption,
  MarketplaceListingListItem,
  MarketplaceSellerListingAvailability,
  MarketplaceListingTermsPreview,
  MarketplaceMarketSummary,
} from "./features/listings/api/contracts";
export type {
  OfferMatchDetail,
  OfferMatchListItem,
  MarketplaceOffer,
  SubmittedOfferDetail,
  SubmittedOfferListItem,
} from "./features/offers/api/contracts";

import type {
  MarketplaceItemListing,
  MarketplaceListingDetail,
  MarketplaceListingFeeLockReportEntry,
  MarketplaceListingFeeHistoryEntry,
  MarketplaceListingInventoryItemOption,
  MarketplaceListingListItem,
  MarketplaceSellerListingAvailability,
  MarketplaceListingTermsPreview,
  MarketplaceMarketSummary,
} from "./features/listings/api/contracts";
import type {
  OfferMatchDetail,
  OfferMatchListItem,
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
    super(
      typeof body === "object" && body !== null && "error" in body
        ? String((body as Record<string, unknown>).error)
        : `API error ${status}`,
    );
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

function queryFromString(query: string) {
  const params = new URLSearchParams(query);
  return Object.fromEntries(params.entries());
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new MarketplaceApiError(response.status, errorBody);
  }

  return response.json() as Promise<T>;
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
  const client = hc<MarketplaceApiApp>(baseUrl, {
    fetch: configuredFetch,
  }) as unknown as HonoClientResource;
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
    async listItemListings(
      productId: string,
    ): Promise<ListResponse<MarketplaceItemListing>> {
      return parseJsonResponse(
        await client["products"][":productId"].listings.$get({
          param: { productId },
          header: headers,
        }),
      );
    },
    async listSellerListings(
      query = "",
    ): Promise<ListResponse<MarketplaceListingListItem>> {
      return parseJsonResponse(
        await client.account.listings.$get({
          query: queryFromString(query),
          header: headers,
        }),
      );
    },
    async listSellerListingInventory(
      query = "",
    ): Promise<ListResponse<MarketplaceListingInventoryItemOption>> {
      return parseJsonResponse(
        await client.account["listing-inventory"].$get({
          query: queryFromString(query),
          header: headers,
        }),
      );
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
    async getSellerListing(id: string): Promise<MarketplaceListingDetail> {
      return parseJsonResponse(
        await client.account.listings[":id"].$get({
          param: { id },
          header: headers,
        }),
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
    async listSellerListingFeeLockReport(
      query = "",
    ): Promise<ListResponse<MarketplaceListingFeeLockReportEntry>> {
      return parseJsonResponse(
        await client.account.listings["fee-lock-report"].$get({
          query: queryFromString(query),
          header: headers,
        }),
      );
    },
    async createListing(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.account.listings.$post({
          json: body,
          header: headers,
        }),
      );
    },
    async previewListingTerms(
      body: Record<string, unknown>,
    ): Promise<MarketplaceListingTermsPreview> {
      return parseJsonResponse(
        await client.account.listings.preview.$post({
          json: body,
          header: headers,
        }),
      );
    },
    async updateListingPrice(id: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.account.listings[":id"].price.$post({
          param: { id },
          json: body,
          header: headers,
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
    async listSubmittedOffers(
      query = "",
    ): Promise<ListResponse<SubmittedOfferListItem>> {
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
    async listOfferMatches(
      query = "",
    ): Promise<ListResponse<OfferMatchListItem>> {
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
    async previewOfferAcceptanceTerms(
      id: string,
    ): Promise<MarketplaceListingTermsPreview> {
      return parseJsonResponse(
        await client.account.offers.matches[":id"]["terms-preview"].$get({
          param: { id },
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
    async getOfferMatchSellList(): Promise<ListResponse<OfferMatchListItem>> {
      return parseJsonResponse(
        await client.account.offers["match-sell-list"].$get({
          header: headers,
        }),
      );
    },
    async addOfferMatchSellListItem(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.account.offers["match-sell-list"].$post({
          json: body,
          header: headers,
        }),
      );
    },
    async acceptOfferMatchSellList(body: Record<string, unknown> = {}) {
      return parseJsonResponse(
        await client.account.offers["match-sell-list"].accept.$post({
          json: body,
          header: headers,
        }),
      );
    },
  };
}

export const marketplaceApi = createMarketplaceApiClient();
