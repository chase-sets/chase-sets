import { hc } from "hono/client";
import type { HonoClientResource } from "@chase-sets/http/hono-client";
import type { buildDiscoveryApi } from "./api";
import type {
  CategoryListResponse,
  DiscoveryCategoryItem,
} from "./features/categories/api/contracts";
import type {
  CreateProductAlertRequest,
  ProductAlertListResponse,
} from "./features/product-alerts/api/contracts";

export type {
  DiscoveryItemDetail,
  DiscoveryPublicListing,
  DiscoveryPublicSeller,
  DiscoverySitemapUrl,
  DiscoverySearchResponse,
} from "./support/client-support/contracts";
export type {
  CategoryListResponse,
  DiscoveryCategoryItem,
} from "./features/categories/api/contracts";
export type {
  CreateProductAlertRequest,
  ProductAlertListResponse,
} from "./features/product-alerts/api/contracts";
export type { ProductAlertPageRow } from "./features/product-alerts/read-model/queries";

import type {
  DiscoveryItemDetail,
  DiscoveryPublicListing,
  DiscoveryPublicSeller,
  DiscoverySitemapUrl,
  DiscoverySearchResponse,
} from "./support/client-support/contracts";

type DiscoveryApiApp = ReturnType<typeof buildDiscoveryApi>;

const DEFAULT_BASE_URL = "/api/marketplace";

export class DiscoveryApiError extends Error {
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

export interface DiscoveryApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

function resolveHeaders(
  headers?: HeadersInit | (() => HeadersInit),
) {
  return typeof headers === "function" ? headers() : headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new DiscoveryApiError(response.status, errorBody);
  }

  return response.json() as Promise<T>;
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
  const client = hc<DiscoveryApiApp>(baseUrl, {
    fetch: configuredFetch,
  }) as unknown as HonoClientResource;
  const headers = resolveHeaders(initialHeaders);

  return {
    async searchItems(query = ""): Promise<DiscoverySearchResponse> {
      return parseJsonResponse(
        await client.items.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
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
        await client.categories.$get({ header: headers }),
      );
    },
    async listProductAlerts(): Promise<ProductAlertListResponse> {
      return parseJsonResponse(
        await client.account["product-alerts"].$get({ header: headers }),
      );
    },
    async createProductAlert(body: CreateProductAlertRequest) {
      return parseJsonResponse(
        await client.account["product-alerts"].$post({
          json: body,
          header: headers,
        }),
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
    async getPublicListingBySlug(slug: string): Promise<DiscoveryPublicListing> {
      return parseJsonResponse(
        await client.listings[":slug"].$get({
          param: { slug },
          header: headers,
        }),
      );
    },
    async getPublicSellerBySlug(slug: string): Promise<DiscoveryPublicSeller> {
      return parseJsonResponse(
        await client.sellers[":slug"].$get({
          param: { slug },
          header: headers,
        }),
      );
    },
    async listSitemapUrls(): Promise<{ items: DiscoverySitemapUrl[]; total: number; count: number }> {
      return parseJsonResponse(
        await client["sitemap-urls"].$get({ header: headers }),
      );
    },
  };
}

export const discoveryApi = createDiscoveryApiClient();
