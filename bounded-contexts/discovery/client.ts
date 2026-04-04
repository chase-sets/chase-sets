export { default as contextManifest } from "./context.json";
import { hc } from "hono/client";
import type { buildDiscoveryApi } from "./api";
import type {
  CategoryListResponse,
  DiscoveryCategoryItem,
} from "./categories/ui/contracts";

export type {
  DiscoveryItemDetail,
  DiscoverySearchResponse,
} from "./items/client-support/contracts";
export type {
  CategoryListResponse,
  DiscoveryCategoryItem,
} from "./categories/ui/contracts";

import type {
  DiscoveryItemDetail,
  DiscoverySearchResponse,
} from "./items/client-support/contracts";

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
  const client = hc<DiscoveryApiApp>(baseUrl, { fetch: configuredFetch }) as any;
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
  };
}

export const discoveryApi = createDiscoveryApiClient();
