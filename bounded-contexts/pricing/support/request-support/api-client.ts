import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, readApiErrorMessage, type ListResponse } from "@chase-sets/http/responses";
import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { buildPricingApi } from "../../api";
import type { AccountRecommendationListItem } from "../../features/recommendations/read-model/queries";
import type { PricingRecommendationJobStatus } from "../../features/recommendations/api/runtime";
import type { BulkRepriceJobStatus } from "../../features/bulk-reprice-ingestion/api/runtime";
import type {
  PublicMarketPageData,
  PublicMarketPageSitemapEntry,
} from "../../features/public-market-pages/read-model/queries";
import type {
  GetProductRollupSeriesParams,
  ProductRollupSeriesPoint,
} from "../../features/market-rollups/read-model/queries";
import type { ProductMarketStatsSnapshotResponse } from "../../features/market-rollups/api/runtime";
import type { RepricingPolicyState } from "../../features/repricing-policies/domain/domain";
import type { RepricingHaltState } from "../../features/repricing-policies/domain/halt";
import type { RepricingDryRun } from "../../features/repricing-engine/api/dry-run";
import type { RepricingActivityFilter, listRepricingActivity } from "../../features/repricing-engine/api/activity";

export type RepricingPolicyListItem = RepricingPolicyState & Readonly<{ changesUsedToday: number }>;
export type RepricingBudget = Readonly<{ day: string; changesUsed: number }>;
export type RepricingActivityPage = Awaited<ReturnType<typeof listRepricingActivity>>;
export type RepricingActivityQuery = Readonly<{ filter?: RepricingActivityFilter; after?: string; limit?: number }>;
export type { RepricingPolicyState, RepricingHaltState, RepricingDryRun, RepricingActivityFilter };

export type { AccountRecommendationListItem } from "../../features/recommendations/read-model/queries";
export type {
  GetProductRollupSeriesParams,
  MarketStateSnapshotPoint,
  ProductMarketAggregate,
  ProductRollupSeriesPoint,
  RollupGranularity,
} from "../../features/market-rollups/read-model/queries";
export type { ProductMarketStatsSnapshotResponse } from "../../features/market-rollups/api/runtime";
export type {
  PublicMarketPageData,
  PublicMarketPageSitemapEntry,
} from "../../features/public-market-pages/read-model/queries";

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
    ): Promise<ProductMarketStatsSnapshotResponse> {
      return parseJsonResponse(
        await client["market-rollups"][":catalogItemId"][":productId"].stats.$get({
          param: { catalogItemId: params.catalogItemId, productId: params.productId },
          header: headers,
        }),
      );
    },
    /** Public, unauthenticated -- returns null on 404 rather than throwing. */
    async getPublicMarketPage(slug: string): Promise<PublicMarketPageData | null> {
      const response = await client.public["market-pages"][":slug"].$get({
        param: { slug },
        header: headers,
      });
      if (response.status === 404) {
        return null;
      }
      return parseJsonResponse(response);
    },
    async listPublicMarketPageSlugs(limit?: number): Promise<{ items: readonly PublicMarketPageSitemapEntry[] }> {
      return parseJsonResponse(
        await client.public["market-pages"].$get({
          query: limit ? { limit: String(limit) } : {},
          header: headers,
        }),
      );
    },
    async createBulkRepriceJob(
      body: Readonly<{ csvText?: string; sourceFilename?: string | null }>,
    ): Promise<BulkRepriceJobStatus> {
      return parseJsonResponse(
        await client.account["bulk-reprice"].$post({
          json: body,
          header: headers,
        }),
      );
    },
    async getBulkRepriceJob(jobId: string): Promise<BulkRepriceJobStatus> {
      return parseJsonResponse(
        await client.account["bulk-reprice"].jobs[":jobId"].$get({
          param: { jobId },
          header: headers,
        }),
      );
    },
    async listRepricingPolicies(): Promise<readonly RepricingPolicyListItem[]> {
      return parseJsonResponse(await client.account["repricing-policies"].$get({ header: headers }));
    },
    async getRepricingPolicy(policyId: string): Promise<RepricingPolicyState> {
      return parseJsonResponse(
        await client.account["repricing-policies"][":policyId"].$get({ param: { policyId }, header: headers }),
      );
    },
    async pauseRepricingPolicy(policyId: string): Promise<RepricingPolicyState> {
      return parseJsonResponse(
        await client.account["repricing-policies"][":policyId"].pause.$post({ param: { policyId }, header: headers }),
      );
    },
    async resumeRepricingPolicy(policyId: string): Promise<RepricingPolicyState> {
      return parseJsonResponse(
        await client.account["repricing-policies"][":policyId"].resume.$post({ param: { policyId }, header: headers }),
      );
    },
    async deleteRepricingPolicy(policyId: string): Promise<RepricingPolicyState> {
      return parseJsonResponse(
        await client.account["repricing-policies"][":policyId"].delete.$post({ param: { policyId }, header: headers }),
      );
    },
    async getRepricingHalt(): Promise<RepricingHaltState> {
      return parseJsonResponse(await client.account["repricing-policies"].halt.$get({ header: headers }));
    },
    async setRepricingHalt(engaged: boolean): Promise<RepricingHaltState> {
      return parseJsonResponse(
        await client.account["repricing-policies"].halt.$post({ json: { engaged }, header: headers }),
      );
    },
    async getRepricingBudget(): Promise<RepricingBudget> {
      return parseJsonResponse(await client.account["repricing-policies"].budget.$get({ query: {}, header: headers }));
    },
    async listRepricingDryRuns(limit = 5): Promise<readonly RepricingDryRun[]> {
      return parseJsonResponse(
        await client.account["repricing-policies"]["dry-runs"].$get({
          query: { limit: String(limit) },
          header: headers,
        }),
      );
    },
    async listRepricingActivity(policyId: string, query: RepricingActivityQuery = {}): Promise<RepricingActivityPage> {
      return parseJsonResponse(
        await client.account["repricing-policies"][":policyId"].activity.$get({
          param: { policyId },
          query: {
            ...(query.filter ? { filter: query.filter } : {}),
            ...(query.after ? { after: query.after } : {}),
            ...(query.limit ? { limit: String(query.limit) } : {}),
          },
          header: headers,
        }),
      );
    },
    async cancelBulkRepriceJob(jobId: string): Promise<BulkRepriceJobStatus> {
      return parseJsonResponse(
        await client.account["bulk-reprice"].jobs[":jobId"].cancel.$post({
          param: { jobId },
          json: {},
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
