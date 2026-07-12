import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, readApiErrorMessage, type ListResponse } from "@chase-sets/http/responses";
import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { buildPricingApi } from "../../api";
import type { AccountRecommendationListItem } from "../../features/recommendations/read-model/queries";
import type { PricingRecommendationJobStatus } from "../../features/recommendations/api/runtime";
import type {
  GetProductRollupSeriesParams,
  ProductMarketStatsSnapshot,
  ProductRollupSeriesPoint,
} from "../../features/market-rollups/read-model/queries";

export type { AccountRecommendationListItem } from "../../features/recommendations/read-model/queries";
export type {
  GetProductRollupSeriesParams,
  MarketStateSnapshotPoint,
  ProductMarketAggregate,
  ProductMarketStatsSnapshot,
  ProductRollupSeriesPoint,
  RollupGranularity,
} from "../../features/market-rollups/read-model/queries";

type PricingApiApp = ReturnType<typeof buildPricingApi>;

export class PricingApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(readApiErrorMessage(body, `API error ${status}`));
  }
}

export interface PricingApiClientOptions {
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
    throw new PricingApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

export function createPricingApiClient({
  baseUrl = "/api/marketplace",
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: PricingApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = honoClientResource(
    hc<PricingApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);

  return {
    async listAccountRecommendations(query = ""): Promise<ListResponse<AccountRecommendationListItem>> {
      return parseJsonResponse(
        await client.account.recommendations.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getAccountRecommendation(id: string): Promise<AccountRecommendationListItem> {
      return parseJsonResponse(
        await client.account.recommendations[":id"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async getRecommendationJob(jobId: string): Promise<PricingRecommendationJobStatus> {
      return parseJsonResponse(
        await client.account["recommendation-jobs"][":jobId"].$get({
          param: { jobId },
          header: headers,
        }),
      );
    },
    async refreshRecommendations(): Promise<PricingRecommendationJobStatus> {
      return parseJsonResponse(
        await client.account.recommendations.refresh.$post({
          json: {},
          header: headers,
        }),
      );
    },
    async applyRecommendations(recommendationIds: readonly string[]): Promise<PricingRecommendationJobStatus> {
      return parseJsonResponse(
        await client.account.recommendations.apply.$post({
          json: { recommendationIds },
          header: headers,
        }),
      );
    },
    async dismissRecommendations(recommendationIds: readonly string[]): Promise<PricingRecommendationJobStatus> {
      return parseJsonResponse(
        await client.account.recommendations.dismiss.$post({
          json: { recommendationIds },
          header: headers,
        }),
      );
    },
    async getProductRollupSeries(
      params: GetProductRollupSeriesParams,
    ): Promise<{ items: readonly ProductRollupSeriesPoint[] }> {
      return parseJsonResponse(
        await client["market-rollups"][":catalogItemId"][":productId"].series.$get({
          param: { catalogItemId: params.catalogItemId, productId: params.productId },
          query: {
            from: params.from,
            to: params.to,
            ...(params.granularity ? { granularity: params.granularity } : {}),
          },
          header: headers,
        }),
      );
    },
    async getProductMarketStatsSnapshot(
      params: Readonly<{ catalogItemId: string; productId: string }>,
    ): Promise<ProductMarketStatsSnapshot> {
      return parseJsonResponse(
        await client["market-rollups"][":catalogItemId"][":productId"].stats.$get({
          param: { catalogItemId: params.catalogItemId, productId: params.productId },
          header: headers,
        }),
      );
    },
  };
}

export const pricingApi = createPricingApiClient();

export function createPricingRequestApiClient(request: Request) {
  return createPricingApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "pricing" }),
  });
}
