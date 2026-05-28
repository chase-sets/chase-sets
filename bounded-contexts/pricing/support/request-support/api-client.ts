import { hc } from "hono/client";
import type { HonoClientResource } from "@chase-sets/http/hono-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { readApiErrorMessage } from "@chase-sets/http/responses";
import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { buildPricingApi } from "../../api";
import type { AccountRecommendationListItem } from "../../features/recommendations/read-model/queries";
import type { PricingRecommendationJob } from "../../features/recommendations/api/runtime";

export type { AccountRecommendationListItem } from "../../features/recommendations/read-model/queries";

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

  return response.json() as Promise<T>;
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
  const client = hc<PricingApiApp>(baseUrl, {
    fetch: configuredFetch,
  }) as unknown as HonoClientResource;
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
    async refreshRecommendations(): Promise<PricingRecommendationJob> {
      return parseJsonResponse(
        await client.account.recommendations.refresh.$post({
          json: {},
          header: headers,
        }),
      );
    },
    async applyRecommendations(recommendationIds: readonly string[]): Promise<PricingRecommendationJob> {
      return parseJsonResponse(
        await client.account.recommendations.apply.$post({
          json: { recommendationIds },
          header: headers,
        }),
      );
    },
    async dismissRecommendations(recommendationIds: readonly string[]): Promise<PricingRecommendationJob> {
      return parseJsonResponse(
        await client.account.recommendations.dismiss.$post({
          json: { recommendationIds },
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
    fetch: createForwardedAuthFetch(request),
  });
}
