import { hc } from "hono/client";
import type { ListResponse } from "@chase-sets/http/responses";
import type { buildMarketplaceApi } from "./api";

export { MarketplaceListingListPage } from "./listings/ui/listing-list-page";
export { MarketplaceListingDetailPage } from "./listings/ui/listing-detail-page";
export { MarketplaceBuyerOfferListPage } from "./offers/ui/buyer-offer-list-page";
export { MarketplaceBuyerOfferDetailPage } from "./offers/ui/buyer-offer-detail-page";
export { MarketplaceSellerOfferListPage } from "./offers/ui/seller-offer-list-page";
export { MarketplaceSellerOfferDetailPage } from "./offers/ui/seller-offer-detail-page";
export { MarketplaceOfferSubmissionSection } from "./offers/ui/offer-submission-section";
export type {
  MarketplaceItemListing,
  MarketplaceListingDetail,
  MarketplaceListingInventoryRecordOption,
  MarketplaceListingListItem,
  MarketplaceMarketSummary,
} from "./listings/ui/contracts";
export type {
  MarketplaceBuyerOfferDetail,
  MarketplaceOfferListItem,
  MarketplaceSellerOfferDetail,
  MarketplaceSellerOfferListItem,
} from "./offers/ui/contracts";

import type {
  MarketplaceItemListing,
  MarketplaceListingDetail,
  MarketplaceListingListItem,
  MarketplaceMarketSummary,
} from "./listings/ui/contracts";
import type {
  MarketplaceBuyerOfferDetail,
  MarketplaceOfferListItem,
  MarketplaceSellerOfferDetail,
  MarketplaceSellerOfferListItem,
} from "./offers/ui/contracts";
import type {
  DiscoveryItemDetail,
  DiscoverySearchResponse,
} from "../discovery/items/client-support/contracts";
import type { CategoryListResponse } from "../discovery/categories/ui/contracts";

type MarketplaceApiApp = ReturnType<typeof buildMarketplaceApi>;

const DEFAULT_BASE_URL = "/api/marketplace";

export class ApiError extends Error {
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
    throw new ApiError(response.status, errorBody);
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
  const client = hc<MarketplaceApiApp>(baseUrl, { fetch: configuredFetch }) as any;
  const headers = resolveHeaders(initialHeaders);

  return {
    async searchItems(query: string): Promise<DiscoverySearchResponse> {
      return parseJsonResponse(
        await client.items.$get({
          query: queryFromString(query),
          header: headers,
        }),
      );
    },
    async getItemDetail(id: string): Promise<DiscoveryItemDetail> {
      return parseJsonResponse(
        await client.items[":id"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async listCategories(): Promise<CategoryListResponse> {
      return parseJsonResponse(
        await client.categories.$get({
          header: headers,
        }),
      );
    },
    async getMarketSummary(itemId: string): Promise<MarketplaceMarketSummary> {
      return parseJsonResponse(
        await client.items[":id"]["market-summary"].$get({
          param: { id: itemId },
          header: headers,
        }),
      );
    },
    async listItemListings(
      itemId: string,
    ): Promise<ListResponse<MarketplaceItemListing>> {
      return parseJsonResponse(
        await client.items[":id"].listings.$get({
          param: { id: itemId },
          header: headers,
        }),
      );
    },
    async listSellerListings(
      query = "",
    ): Promise<ListResponse<MarketplaceListingListItem>> {
      return parseJsonResponse(
        await client.seller.listings.$get({
          query: queryFromString(query),
          header: headers,
        }),
      );
    },
    async getSellerListing(id: string): Promise<MarketplaceListingDetail> {
      return parseJsonResponse(
        await client.seller.listings[":id"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async createListing(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.seller.listings.$post({
          json: body,
          header: headers,
        }),
      );
    },
    async updateListingPrice(id: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.seller.listings[":id"].price.$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async updateListingQuantityCap(id: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.seller.listings[":id"]["quantity-cap"].$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async publishListing(id: string) {
      return parseJsonResponse(
        await client.seller.listings[":id"].publish.$post({
          param: { id },
          json: {},
          header: headers,
        }),
      );
    },
    async pauseListing(id: string) {
      return parseJsonResponse(
        await client.seller.listings[":id"].pause.$post({
          param: { id },
          json: {},
          header: headers,
        }),
      );
    },
    async withdrawListing(id: string) {
      return parseJsonResponse(
        await client.seller.listings[":id"].withdraw.$post({
          param: { id },
          json: {},
          header: headers,
        }),
      );
    },
    async listBuyerOffers(
      query = "",
    ): Promise<ListResponse<MarketplaceOfferListItem>> {
      return parseJsonResponse(
        await client.buyer.offers.$get({
          query: queryFromString(query),
          header: headers,
        }),
      );
    },
    async getBuyerOffer(id: string): Promise<MarketplaceBuyerOfferDetail> {
      return parseJsonResponse(
        await client.buyer.offers[":id"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async createBuyerOffer(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.buyer.offers.$post({
          json: body,
          header: headers,
        }),
      );
    },
    async listSellerOffers(
      query = "",
    ): Promise<ListResponse<MarketplaceSellerOfferListItem>> {
      return parseJsonResponse(
        await client.seller.offers.$get({
          query: queryFromString(query),
          header: headers,
        }),
      );
    },
    async getSellerOffer(id: string): Promise<MarketplaceSellerOfferDetail> {
      return parseJsonResponse(
        await client.seller.offers[":id"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async acceptSellerOffer(id: string) {
      return parseJsonResponse(
        await client.seller.offers[":id"].accept.$post({
          param: { id },
          json: {},
          header: headers,
        }),
      );
    },
  };
}

export const marketplaceApi = createMarketplaceApiClient();
