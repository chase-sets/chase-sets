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
import {
  parseRepricingConfigurationReceipt,
  parseRepricingConfigurationStatus,
  type RepricingConfigurationStatus,
  type RepricingConfigurationReceipt,
  type RepricingPolicyReceipt,
  type RepricingHaltReceipt,
} from "../../features/repricing-policies/domain/configuration-receipt";
import {
  parseRepricingPolicyState,
  parseRepricingHaltState,
} from "../../features/repricing-policies/domain/configuration-state";
import type { RepricingDryRun, RepricingDryRunBody } from "../../features/repricing-engine/api/dry-run";
import type { RepricingPolicyListingTrace } from "../../features/repricing-engine/domain/fact";
import type {
  RepricingAuthoringPrerequisites,
  RepricingScopePreview,
  RepricingScopePreviewInput,
  listRepricingCategories,
} from "../../features/repricing-policies/read-model/controls";
import type { RepricingActivityFilter, listRepricingActivity } from "../../features/repricing-engine/api/activity";
import type { ApplyGoalRequest, ApplyGoalResult, PricingHealthData } from "../../features/pricing-health/api/services";
import type { GoalParameterRequest } from "../../features/pricing-health/api/goal-comparison";

export type RepricingPolicyListItem = RepricingPolicyState &
  Readonly<{ changesUsedToday: number; configuration?: RepricingConfigurationStatus<RepricingPolicyState> }>;
export type RepricingBudget = Readonly<{ day: string; changesUsed: number }>;
export type RepricingActivityPage = Awaited<ReturnType<typeof listRepricingActivity>>;
export type RepricingActivityQuery = Readonly<{ filter?: RepricingActivityFilter; after?: string; limit?: number }>;
export type { RepricingPolicyState, RepricingHaltState, RepricingDryRun, RepricingActivityFilter };
export type { RepricingConfigurationReceipt, RepricingPolicyReceipt, RepricingHaltReceipt };

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

export function pricingValidationMessages(error: unknown): readonly string[] {
  if (!(error instanceof PricingApiError) || error.status !== 400) return [];
  const body = error.body;
  if (!body || typeof body !== "object" || !("error" in body)) return [];
  const envelope = body.error;
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !("code" in envelope) ||
    envelope.code !== "validation_failed" ||
    !("details" in envelope) ||
    !Array.isArray(envelope.details)
  )
    return [];
  return envelope.details.flatMap((detail: unknown) =>
    detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string"
      ? [detail.message]
      : [],
  );
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

async function parseConfigurationResponse<State>(
  response: Response,
  parseState: (value: unknown) => State,
): Promise<RepricingConfigurationReceipt<State>> {
  const body: unknown = await response.json();
  if (![200, 201, 202, 409].includes(response.status)) throw new PricingApiError(response.status, body);
  let receipt: RepricingConfigurationReceipt<State>;
  try {
    receipt = parseRepricingConfigurationReceipt(body, parseState);
  } catch {
    throw new PricingApiError(response.ok ? 502 : response.status, body);
  }
  const expected =
    receipt.status === "accepted-pending" ? 202 : receipt.status === "superseded-by-revision" ? 409 : null;
  if (expected === null ? ![200, 201].includes(response.status) : response.status !== expected)
    throw new PricingApiError(502, { error: { code: "invalid_configuration_receipt" } });
  return attachResponseMetadata(receipt, response);
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
  const writeHeaders = (requestKey: string) => ({
    ...Object.fromEntries(new Headers(headers)),
    "Idempotency-Key": requestKey,
  });

  return {
    async getPricingHealth(
      policyId?: string,
      goals?: readonly GoalParameterRequest[],
    ): Promise<PricingHealthData & { canCompute: boolean }> {
      return parseJsonResponse(
        await client.account["pricing-health"].$get({
          query: {
            ...(policyId === undefined ? {} : { policyId }),
            ...(goals === undefined ? {} : { goals: JSON.stringify(goals) }),
          },
          header: headers,
        }),
      );
    },
    async computePricingHealth(policyId: string): Promise<{ dryRunId: string }> {
      return parseJsonResponse(
        await client.account["pricing-health"][":policyId"].compute.$post({
          param: { policyId },
          header: headers,
        }),
      );
    },
    async comparePricingHealth(
      policyId: string,
      goals?: readonly GoalParameterRequest[],
    ): Promise<{ runs: readonly { goalId: string; goalVersion: number; dryRunId: string }[] }> {
      const response =
        goals === undefined
          ? await client.account["pricing-health"][":policyId"].compare.$post({
              param: { policyId },
              header: headers,
            })
          : await client.account["pricing-health"][":policyId"].compare.$post({
              param: { policyId },
              json: { goals },
              header: headers,
            });
      return parseJsonResponse(response);
    },
    async applyPricingHealthGoal(policyId: string, body: ApplyGoalRequest): Promise<ApplyGoalResult> {
      const response = await client.account["pricing-health"][":policyId"]["apply-goal"].$post({
        param: { policyId },
        json: body,
        header: headers,
      });
      const original = response.clone();
      const receipt = await parseConfigurationResponse(response, parseRepricingPolicyState);
      if (receipt.status !== "applied") return receipt;
      const result: Extract<ApplyGoalResult, { status: "applied" }> = await original.json();
      if (
        !Number.isSafeInteger(result.previousRevision) ||
        result.previousRevision < 0 ||
        !Number.isSafeInteger(result.revision) ||
        result.revision !== result.previousRevision + 1 ||
        result.policyId !== receipt.state.policyId ||
        typeof result.bodyHash !== "string" ||
        typeof result.dryRunId !== "string" ||
        typeof result.goalId !== "string" ||
        !Number.isSafeInteger(result.goalVersion) ||
        result.goalVersion < 1 ||
        !result.parameters ||
        typeof result.parameters !== "object" ||
        Array.isArray(result.parameters) ||
        !Object.values(result.parameters).every(Number.isFinite) ||
        !result.movement ||
        !result.alerts ||
        ![
          result.movement.raised,
          result.movement.lowered,
          result.movement.held,
          result.alerts.floorBinding,
          result.alerts.evidenceFloorBinding,
        ].every((value) => Number.isSafeInteger(value) && value >= 0)
      )
        throw new PricingApiError(502, { error: { code: "invalid_configuration_receipt" } });
      return attachResponseMetadata({ ...result, ...receipt }, original);
    },
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
            currencyCode: params.currencyCode,
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
      const response = await client.account["repricing-policies"].$get({ header: headers });
      const body: unknown = await parseJsonResponse(response);
      if (!Array.isArray(body)) throw new PricingApiError(502, { error: { code: "invalid_configuration_status" } });
      return attachResponseMetadata(
        body.map((value) => {
          const state = parseRepricingPolicyState(value);
          if (
            !value ||
            typeof value !== "object" ||
            !("configuration" in value) ||
            !("changesUsedToday" in value) ||
            !Number.isSafeInteger(value.changesUsedToday) ||
            value.changesUsedToday < 0
          )
            throw new PricingApiError(502, { error: { code: "invalid_configuration_status" } });
          return {
            ...state,
            changesUsedToday: value.changesUsedToday,
            configuration: parseRepricingConfigurationStatus(value.configuration, parseRepricingPolicyState),
          };
        }),
        response,
      );
    },
    async listRepricingConfigurationRequests(): Promise<
      readonly RepricingConfigurationReceipt<RepricingPolicyState | RepricingHaltState>[]
    > {
      const body: unknown = await parseJsonResponse(
        await client.account["repricing-policies"]["configuration-requests"].$get({ header: headers }),
      );
      if (!Array.isArray(body) || body.length > 100)
        throw new PricingApiError(502, { error: { code: "invalid_configuration_status" } });
      return body.map((value) =>
        parseRepricingConfigurationReceipt<RepricingPolicyState | RepricingHaltState>(value, (state) =>
          state && typeof state === "object" && "engaged" in state
            ? parseRepricingHaltState(state)
            : parseRepricingPolicyState(state),
        ),
      );
    },
    async getRepricingAuthoringPrerequisites(): Promise<RepricingAuthoringPrerequisites> {
      return parseJsonResponse(
        await client.account["repricing-policies"]["authoring-prerequisites"].$get({ header: headers }),
      );
    },
    async listRepricingCategories(): Promise<Awaited<ReturnType<typeof listRepricingCategories>>> {
      return parseJsonResponse(await client.account["repricing-policies"].categories.$get({ header: headers }));
    },
    async previewRepricingScope(body: Omit<RepricingScopePreviewInput, "accountId">): Promise<RepricingScopePreview> {
      return parseJsonResponse(
        await client.account["repricing-policies"]["scope-preview"].$post({ json: body, header: headers }),
      );
    },
    async createRepricingPolicy(
      body: { dryRunId: string; name: string },
      requestKey: string = crypto.randomUUID(),
    ): Promise<RepricingPolicyReceipt> {
      return parseConfigurationResponse(
        await client.account["repricing-policies"].$post({ json: body, header: writeHeaders(requestKey) }),
        parseRepricingPolicyState,
      );
    },
    async reviseRepricingPolicy(
      policyId: string,
      body: RepricingDryRunBody & { name: string },
      requestKey: string = crypto.randomUUID(),
    ): Promise<RepricingPolicyReceipt> {
      return parseConfigurationResponse(
        await client.account["repricing-policies"][":policyId"].revise.$post({
          param: { policyId },
          json: body,
          header: writeHeaders(requestKey),
        }),
        parseRepricingPolicyState,
      );
    },
    async startRepricingDryRun(body: RepricingDryRunBody & { replacingPolicyId?: string }): Promise<RepricingDryRun> {
      return parseJsonResponse(
        await client.account["repricing-policies"]["dry-runs"].$post({ json: body, header: headers }),
      );
    },
    async getRepricingDryRun(dryRunId: string): Promise<RepricingDryRun> {
      return parseJsonResponse(
        await client.account["repricing-policies"]["dry-runs"][":dryRunId"].$get({
          param: { dryRunId },
          header: headers,
        }),
      );
    },
    async listRepricingDryRunTraces(dryRunId: string, after?: string): Promise<readonly RepricingPolicyListingTrace[]> {
      return parseJsonResponse(
        await client.account["repricing-policies"]["dry-runs"][":dryRunId"].traces.$get({
          param: { dryRunId },
          query: { limit: "100", ...(after ? { after } : {}) },
          header: headers,
        }),
      );
    },
    async getRepricingPolicy(
      policyId: string,
    ): Promise<RepricingPolicyState & { configuration?: RepricingConfigurationStatus<RepricingPolicyState> }> {
      const response = await client.account["repricing-policies"][":policyId"].$get({
        param: { policyId },
        header: headers,
      });
      const value: unknown = await parseJsonResponse(response);
      const state = parseRepricingPolicyState(value);
      if (!value || typeof value !== "object" || !("configuration" in value))
        throw new PricingApiError(502, { error: { code: "invalid_configuration_status" } });
      return attachResponseMetadata(
        { ...state, configuration: parseRepricingConfigurationStatus(value.configuration, parseRepricingPolicyState) },
        response,
      );
    },
    async pauseRepricingPolicy(
      policyId: string,
      requestKey: string = crypto.randomUUID(),
    ): Promise<RepricingPolicyReceipt> {
      return parseConfigurationResponse(
        await client.account["repricing-policies"][":policyId"].pause.$post({
          param: { policyId },
          header: writeHeaders(requestKey),
        }),
        parseRepricingPolicyState,
      );
    },
    async resumeRepricingPolicy(
      policyId: string,
      requestKey: string = crypto.randomUUID(),
    ): Promise<RepricingPolicyReceipt> {
      return parseConfigurationResponse(
        await client.account["repricing-policies"][":policyId"].resume.$post({
          param: { policyId },
          header: writeHeaders(requestKey),
        }),
        parseRepricingPolicyState,
      );
    },
    async deleteRepricingPolicy(
      policyId: string,
      requestKey: string = crypto.randomUUID(),
    ): Promise<RepricingPolicyReceipt> {
      return parseConfigurationResponse(
        await client.account["repricing-policies"][":policyId"].delete.$post({
          param: { policyId },
          header: writeHeaders(requestKey),
        }),
        parseRepricingPolicyState,
      );
    },
    async getRepricingHalt(): Promise<
      RepricingHaltState & { configuration?: RepricingConfigurationStatus<RepricingHaltState> }
    > {
      const response = await client.account["repricing-policies"].halt.$get({ header: headers });
      const value: unknown = await parseJsonResponse(response);
      const state = parseRepricingHaltState(value);
      if (!value || typeof value !== "object" || !("configuration" in value))
        throw new PricingApiError(502, { error: { code: "invalid_configuration_status" } });
      return attachResponseMetadata(
        { ...state, configuration: parseRepricingConfigurationStatus(value.configuration, parseRepricingHaltState) },
        response,
      );
    },
    async setRepricingHalt(engaged: boolean, requestKey: string = crypto.randomUUID()): Promise<RepricingHaltReceipt> {
      return parseConfigurationResponse(
        await client.account["repricing-policies"].halt.$post({ json: { engaged }, header: writeHeaders(requestKey) }),
        parseRepricingHaltState,
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
