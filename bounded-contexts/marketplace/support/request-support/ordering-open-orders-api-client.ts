import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";

/**
 * Cross-context read of the seller's live Open Order count from Ordering
 * (m127). Ordering owns the Open Order claim ledger; the marketplace
 * "Time away & order capacity" settings surface reads this count over HTTP so
 * the "N of M" display is authoritative and never counted client-side. A
 * plain-fetch client (rather than a typed hono client) keeps marketplace free
 * of a build-time dependency on the Ordering package.
 */
export class OrderingOpenOrdersApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Ordering open-orders API error ${status}`);
    this.name = "OrderingOpenOrdersApiError";
  }
}

export interface OrderingOpenOrdersApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
}

export function createOrderingOpenOrdersApiClient({
  baseUrl = "/api/ordering",
  fetch = globalThis.fetch,
  headers,
}: OrderingOpenOrdersApiClientOptions = {}) {
  return {
    /** Own-account seller read: the current count of the seller's Open Orders. */
    async getSellerOpenOrderCount(): Promise<number> {
      const response = await fetch(`${baseUrl}/account/sales/order-capacity`, {
        method: "GET",
        credentials: "include",
        headers,
      });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        throw new OrderingOpenOrdersApiError(response.status, errorBody);
      }

      const body = (await response.json()) as { open_order_count?: number };
      return Number(body.open_order_count ?? 0);
    },
  };
}

export function createOrderingOpenOrdersRequestApiClient(request: Request) {
  return createOrderingOpenOrdersApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/ordering"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "ordering" }),
  });
}
