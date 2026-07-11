import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import type { buildSellerMetricsApi } from "../../features/seller-metrics/api/http";

type SellerMetricsApiApp = ReturnType<typeof buildSellerMetricsApi>;
const DEFAULT_BASE_URL = "/api/marketplace";

export type SellerBehavioralMetricsSummary = Readonly<{
  seller_account_id: string;
  window_days: number;
  orders_created_count: number;
  seller_cancelled_count: number;
  cancellation_rate: string | null;
  shipments_dispatched_count: number;
  shipments_on_time_count: number;
  on_time_shipment_rate: string | null;
  disputes_resolved_count: number;
  disputes_against_seller_count: number;
  dispute_rate: string | null;
  computed_at: string | null;
  updated_at: string | null;
}>;

export type SellerBehavioralMetricsChips = Readonly<{
  sellerAccountId: string;
  shipsOnTime: boolean | null;
  lowCancellationRate: boolean | null;
  lowDisputeRate: boolean | null;
}>;

export class SellerMetricsApiError extends Error {
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

export interface SellerMetricsApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new SellerMetricsApiError(response.status, errorBody);
  }

  return (await response.json()) as T;
}

export function createSellerMetricsApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: SellerMetricsApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = honoClientResource(
    hc<SellerMetricsApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);

  return {
    /** Own-account seller dashboard read (authenticated, own account only). */
    async getOwnBehavioralMetrics(): Promise<SellerBehavioralMetricsSummary> {
      return parseJsonResponse(
        await client.account["seller-metrics"].$get({
          header: headers,
        }),
      );
    },
    /** Public buyer-facing chips for a given seller account (flag-gated + threshold-gated server-side). */
    async getBehavioralMetricsChips(accountId: string): Promise<SellerBehavioralMetricsChips> {
      return parseJsonResponse(
        await client.accounts[":accountId"]["behavioral-metrics-chips"].$get({
          param: { accountId },
          header: headers,
        }),
      );
    },
  };
}
