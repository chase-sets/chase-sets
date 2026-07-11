import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, type ListResponse } from "@chase-sets/http/responses";
import type { buildReviewApi } from "../../features/reviews/api/http";

export type {
  ReviewSummary,
  ReviewOpportunity,
  ReviewDetail,
  ReviewListItem,
} from "../../features/reviews/api/contracts";

import type {
  ReviewSummary,
  ReviewOpportunity,
  ReviewDetail,
  ReviewListItem,
} from "../../features/reviews/api/contracts";

type ReputationApiApp = ReturnType<typeof buildReviewApi>;
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

  return attachResponseMetadata(await response.json(), response) as T;
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
  const client = honoClientResource(
    hc<ReputationApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);

  return {
    async getAccountReviewSummary(accountId: string): Promise<ReviewSummary> {
      return parseJsonResponse(
        await client.accounts[":accountId"]["review-summary"].$get({
          param: { accountId },
          header: headers,
        }),
      );
    },
    async listAccountReviews(accountId: string, query = ""): Promise<ListResponse<ReviewListItem>> {
      return parseJsonResponse(
        await client.accounts[":accountId"].reviews.$get({
          param: { accountId },
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async listWrittenReviews(query = ""): Promise<ListResponse<ReviewListItem>> {
      return parseJsonResponse(
        await client.reviews.written.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async listReceivedReviews(query = ""): Promise<ListResponse<ReviewListItem>> {
      return parseJsonResponse(
        await client.reviews.received.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getAccountReview(reviewId: string): Promise<ReviewDetail> {
      return parseJsonResponse(
        await client.reviews[":id"].$get({
          param: { id: reviewId },
          header: headers,
        }),
      );
    },
    async getOrderReviewOpportunity(orderId: string): Promise<ReviewOpportunity> {
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
    async submitReviewReply(reviewId: string, body: Readonly<{ feedback: string }>) {
      return parseJsonResponse(
        await client.reviews[":id"].reply.$post({
          param: { id: reviewId },
          json: body,
          header: headers,
        }),
      );
    },
  };
}

export const reputationApi = createReputationApiClient();
