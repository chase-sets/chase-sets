import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, readApiErrorMessage } from "@chase-sets/http/responses";
import type { buildDiscoveryApi } from "./api";
import type { CategoryListResponse, DiscoveryCategoryItem } from "./features/categories/api/contracts";
import type {
  AnonymousProductAlertIntent,
  CreateAnonymousProductAlertIntentRequest,
  CreateProductAlertRequest,
  ProductAlertListResponse,
} from "./features/product-alerts/api/contracts";

export type {
  DiscoveryItemDetail,
  DiscoveryItemDetailSellerOverlay,
  DiscoverySimilarItem,
  DiscoverySimilarItemsResponse,
  DiscoveryPublicListing,
  DiscoveryPublicAccount,
  DiscoverySitemapUrl,
  DiscoverySitemapEntityKind,
  DiscoverySitemapEntityCounts,
  DiscoverySearchResponse,
} from "./support/client-support/contracts";
export { DISCOVERY_SITEMAP_ENTITY_KINDS, DISCOVERY_SITEMAP_PAGE_SIZE } from "./support/market-support/queries";
export type { DiscoveryBulkCartPreview } from "./features/search/read-model/queries";
export type { DiscoveryBrowseSetItem, DiscoveryBrowseSetPage } from "./features/browse/api/contracts";
export type { CategoryListResponse, DiscoveryCategoryItem } from "./features/categories/api/contracts";
export type {
  AnonymousProductAlertIntent,
  CreateAnonymousProductAlertIntentRequest,
  CreateProductAlertRequest,
  ProductAlertListResponse,
} from "./features/product-alerts/api/contracts";
export type { ProductAlertPageRow } from "./features/product-alerts/read-model/queries";

import type {
  DiscoveryItemDetail,
  DiscoveryItemDetailSellerOverlay,
  DiscoverySimilarItemsResponse,
  DiscoveryPublicListing,
  DiscoveryPublicAccount,
  DiscoverySitemapUrl,
  DiscoverySitemapEntityKind,
  DiscoverySitemapEntityCounts,
  DiscoverySearchResponse,
} from "./support/client-support/contracts";
import type { DiscoveryBulkCartPreview } from "./features/search/read-model/queries";
import type { DiscoveryBrowseSetPage } from "./features/browse/api/contracts";

type DiscoveryApiApp = ReturnType<typeof buildDiscoveryApi>;

const DEFAULT_BASE_URL = "/api/marketplace";

export class DiscoveryApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(readApiErrorMessage(body, `API error ${status}`));
  }
}

export interface DiscoveryApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  return headers ? Object.fromEntries(new Headers(headers).entries()) : {};
}

function joinApiPath(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new DiscoveryApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

export function createDiscoveryApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: DiscoveryApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = honoClientResource(
    hc<DiscoveryApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);

  return {
    async searchItems(query = ""): Promise<DiscoverySearchResponse> {
      const normalizedQuery = query.startsWith("?") ? query.slice(1) : query;
      const url = `${baseUrl.replace(/\/$/, "")}/items${normalizedQuery ? `?${normalizedQuery}` : ""}`;
      return parseJsonResponse(await configuredFetch(url, { headers }));
    },
    async previewBulkAddSearchResults(query = ""): Promise<DiscoveryBulkCartPreview> {
      const normalizedQuery = query.startsWith("?") ? query.slice(1) : query;
      const url = `${baseUrl.replace(/\/$/, "")}/items/bulk-cart-preview${normalizedQuery ? `?${normalizedQuery}` : ""}`;
      return parseJsonResponse(await configuredFetch(url, { headers }));
    },
    async getItemDetail(id: string): Promise<DiscoveryItemDetail> {
      return parseJsonResponse(
        await client.items[":id"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async getSimilarItems(id: string, limit?: number): Promise<DiscoverySimilarItemsResponse> {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, `/items/${encodeURIComponent(id)}/similar${suffix}`), {
          headers,
        }),
      );
    },
    async getItemDetailSellerOverlay(
      id: string,
      query: Readonly<{ selectedListingId?: string | null }> = {},
    ): Promise<DiscoveryItemDetailSellerOverlay> {
      const params = new URLSearchParams();
      if (query.selectedListingId) {
        params.set("selectedListingId", query.selectedListingId);
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, `/items/${encodeURIComponent(id)}/seller-overlay${suffix}`), {
          headers,
        }),
      );
    },
    async listCategories(): Promise<CategoryListResponse> {
      return parseJsonResponse(await client.categories.$get({ header: headers }));
    },
    async listProductAlerts(): Promise<ProductAlertListResponse> {
      return parseJsonResponse(await client.account["product-alerts"].$get({ header: headers }));
    },
    async createProductAlert(body: CreateProductAlertRequest) {
      return parseJsonResponse(
        await client.account["product-alerts"].$post({
          json: body,
          header: headers,
        }),
      );
    },
    async createAnonymousProductAlertIntent(
      anonymousOwnerId: string,
      body: CreateAnonymousProductAlertIntentRequest,
      options: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<AnonymousProductAlertIntent> {
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, "/guest/product-alert-intents"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
            "x-discovery-anonymous-product-alert-id": anonymousOwnerId,
          },
          body: JSON.stringify(body),
          signal: options.signal,
        }),
      );
    },
    async claimAnonymousProductAlertIntent(
      anonymousOwnerId: string,
      intentId: string,
    ): Promise<AnonymousProductAlertIntent> {
      return parseJsonResponse(
        await configuredFetch(
          joinApiPath(baseUrl, `/account/product-alert-intents/${encodeURIComponent(intentId)}/claim`),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...headersToRecord(headers),
              "x-discovery-anonymous-product-alert-id": anonymousOwnerId,
            },
            body: JSON.stringify({}),
          },
        ),
      );
    },
    async pauseProductAlert(id: string) {
      return parseJsonResponse(
        await client.account["product-alerts"][":id"].pause.$post({
          param: { id },
          json: {},
          header: headers,
        }),
      );
    },
    async resumeProductAlert(id: string) {
      return parseJsonResponse(
        await client.account["product-alerts"][":id"].resume.$post({
          param: { id },
          json: {},
          header: headers,
        }),
      );
    },
    async deleteProductAlert(id: string) {
      return parseJsonResponse(
        await client.account["product-alerts"][":id"].delete.$post({
          param: { id },
          json: {},
          header: headers,
        }),
      );
    },
    async getCategoryBySlug(slug: string): Promise<DiscoveryCategoryItem> {
      return parseJsonResponse(
        await client.categories[":slug"].$get({
          param: { slug },
          header: headers,
        }),
      );
    },
    async getSetBySlug(slug: string): Promise<DiscoveryBrowseSetPage> {
      return parseJsonResponse(
        await client.sets[":slug"].$get({
          param: { slug },
          header: headers,
        }),
      );
    },
    async getPublicListingBySlug(slug: string): Promise<DiscoveryPublicListing> {
      return parseJsonResponse(
        await client.listings[":slug"].$get({
          param: { slug },
          header: headers,
        }),
      );
    },
    async getPublicAccountBySlug(slug: string, query = ""): Promise<DiscoveryPublicAccount> {
      return parseJsonResponse(
        await client.accounts[":slug"].$get({
          param: { slug },
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getSitemapEntityCounts(): Promise<DiscoverySitemapEntityCounts> {
      return parseJsonResponse(await client["sitemap-entity-counts"].$get({ header: headers }));
    },
    async listSitemapEntityPage(
      kind: DiscoverySitemapEntityKind,
      page: number,
    ): Promise<{ items: DiscoverySitemapUrl[]; count: number }> {
      return parseJsonResponse(
        await configuredFetch(joinApiPath(baseUrl, `/sitemap-entities/${kind}/${page}`), {
          headers,
        }),
      );
    },
  };
}

export const discoveryApi = createDiscoveryApiClient();
