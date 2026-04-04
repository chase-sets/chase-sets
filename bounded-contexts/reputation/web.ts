export { default as contextManifest } from "./context.json";
import { hc } from "hono/client";
import type { ListResponse } from "@chase-sets/http/responses";
import type { buildReputationApi } from "./api";

export { ReputationAccountPage } from "./reviews/ui/account-reputation-page";
export { ReputationReviewListPage } from "./reviews/ui/review-list-page";
export { ReputationReviewDetailPage } from "./reviews/ui/review-detail-page";
export { ReputationReviewSubmissionPage } from "./reviews/ui/review-submission-page";
export type {
  ReputationAccountSummary,
  ReputationReviewOpportunity,
  ReputationReviewDetail,
  ReputationReviewListItem,
} from "./reviews/ui/contracts";

import type {
  ReputationAccountSummary,
  ReputationReviewOpportunity,
  ReputationReviewDetail,
  ReputationReviewListItem,
} from "./reviews/ui/contracts";

type ReputationApiApp = ReturnType<typeof buildReputationApi>;
const DEFAULT_BASE_URL = "/api/marketplace";

export class ReputationApiError extends Error {
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

export interface ReputationApiClientOptions {
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
    throw new ReputationApiError(response.status, errorBody);
  }

  return response.json() as Promise<T>;
}

export function createReputationApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: ReputationApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = hc<ReputationApiApp>(baseUrl, { fetch: configuredFetch }) as any;
  const headers = resolveHeaders(initialHeaders);

  return {
    async getAccountReputation(accountId: string): Promise<ReputationAccountSummary> {
      return parseJsonResponse(
        await client.accounts[":accountId"].reputation.$get({
          param: { accountId },
          header: headers,
        }),
      );
    },
    async listAccountReviews(
      accountId: string,
      query = "",
    ): Promise<ListResponse<ReputationReviewListItem>> {
      return parseJsonResponse(
        await client.accounts[":accountId"].reviews.$get({
          param: { accountId },
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async listWrittenReviews(
      query = "",
    ): Promise<ListResponse<ReputationReviewListItem>> {
      return parseJsonResponse(
        await client.reviews.written.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async listReceivedReviews(
      query = "",
    ): Promise<ListResponse<ReputationReviewListItem>> {
      return parseJsonResponse(
        await client.reviews.received.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getAccountReview(reviewId: string): Promise<ReputationReviewDetail> {
      return parseJsonResponse(
        await client.reviews[":id"].$get({
          param: { id: reviewId },
          header: headers,
        }),
      );
    },
    async getOrderReviewOpportunity(
      orderId: string,
    ): Promise<ReputationReviewOpportunity> {
      return parseJsonResponse(
        await client.reviews.opportunities.orders[":orderId"].$get({
          param: { orderId },
          header: headers,
        }),
      );
    },
    async submitReview(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.reviews.$post({
          json: body,
          header: headers,
        }),
      );
    },
    async updateReview(reviewId: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.reviews[":id"].update.$post({
          param: { id: reviewId },
          json: body,
          header: headers,
        }),
      );
    },
    async withdrawReview(reviewId: string) {
      return parseJsonResponse(
        await client.reviews[":id"].withdraw.$post({
          param: { id: reviewId },
          json: {},
          header: headers,
        }),
      );
    },
  };
}

export const reputationApi = createReputationApiClient();
