import { hc } from "hono/client";
import type { buildDiscoveryApi } from "../../api";
import type { CategoryListResponse } from "../../features/categories/ui/contracts";
import type {
  DiscoveryItemDetail,
  DiscoverySearchResponse,
} from "./contracts";

type DiscoveryApiApp = ReturnType<typeof buildDiscoveryApi>;

const DEFAULT_BASE_URL = "/api/marketplace";

export class ApiError extends Error {
  constructor(
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

type DiscoveryItemsResponse = DiscoverySearchResponse;
type DiscoveryItemResponse = DiscoveryItemDetail;
type DiscoveryCategoriesResponse = CategoryListResponse;

export interface DiscoveryApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
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

export function createDiscoveryApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
}: DiscoveryApiClientOptions = {}) {
  const client = hc<DiscoveryApiApp>(baseUrl, { fetch }) as any;

  return {
    async searchItems(query: string): Promise<DiscoveryItemsResponse> {
      const response = await client.items.$get({
        query: queryFromString(query),
      });
      return parseJsonResponse<DiscoveryItemsResponse>(response);
    },
    async getItemDetail(id: string): Promise<DiscoveryItemResponse> {
      const response = await client.items[":id"].$get({
        param: { id },
      });
      return parseJsonResponse<DiscoveryItemResponse>(response);
    },
    async listCategories(): Promise<DiscoveryCategoriesResponse> {
      const response = await client.categories.$get();
      return parseJsonResponse<DiscoveryCategoriesResponse>(response);
    },
  };
}

export const discoveryApi = createDiscoveryApiClient();
