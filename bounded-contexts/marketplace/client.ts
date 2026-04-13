import { hc } from "hono/client";
import type { ListResponse } from "@chase-sets/http/responses";
import type { buildMarketplaceApi } from "./api";

export type {
  MarketplaceItemListing,
  MarketplaceListingDetail,
  MarketplaceListingInventoryRecordOption,
  MarketplaceListingListItem,
  MarketplaceMarketSummary,
} from "./features/listings/api/contracts";
export type {
  MarketplaceBuyerOfferDetail,
  MarketplaceOfferListItem,
  MarketplaceSellerOfferDetail,
  MarketplaceSellerOfferListItem,
} from "./features/offers/api/contracts";

import type {
  MarketplaceItemListing,
  MarketplaceListingDetail,
  MarketplaceListingListItem,
  MarketplaceMarketSummary,
} from "./features/listings/api/contracts";
import type {
  MarketplaceBuyerOfferDetail,
  MarketplaceOfferListItem,
  MarketplaceSellerOfferDetail,
  MarketplaceSellerOfferListItem,
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
  const client = hc<MarketplaceApiApp>(baseUrl, { fetch: configuredFetch }) as any;
  const headers = resolveHeaders(initialHeaders);

  return {
    async getMarketSummary(catalogVersionKey: string): Promise<MarketplaceMarketSummary> {
      return parseJsonResponse(
        await client["sellable-units"][":catalogVersionKey"]["market-summary"].$get({
          param: { catalogVersionKey },
          header: headers,
        }),
      );
    },
    async listItemListings(
      catalogVersionKey: string,
    ): Promise<ListResponse<MarketplaceItemListing>> {
      return parseJsonResponse(
        await client["sellable-units"][":catalogVersionKey"].listings.$get({
          param: { catalogVersionKey },
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
