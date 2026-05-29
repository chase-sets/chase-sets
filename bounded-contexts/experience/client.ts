import { attachResponseMetadata, type ListResponse } from "@chase-sets/http/responses";
import type {
  DismissPlatformFeedbackPromptRequest,
  PlatformFeedbackDetail,
  PlatformFeedbackListItem,
  PlatformFeedbackMetrics,
  PlatformFeedbackPromptEligibility,
  SubmitPlatformFeedbackRequest,
} from "./features/platform-feedback/api/contracts";

const DEFAULT_BASE_URL = "/api/experience";

export type {
  DismissPlatformFeedbackPromptRequest,
  PlatformFeedbackDetail,
  PlatformFeedbackListItem,
  PlatformFeedbackMetrics,
  PlatformFeedbackPromptEligibility,
  SubmitPlatformFeedbackRequest,
} from "./features/platform-feedback/api/contracts";

export class ExperienceApiError extends Error {
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

export interface ExperienceApiClientOptions {
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
    throw new ExperienceApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

function toQuery(params: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export function createExperienceApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: ExperienceApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
      headers: {
        "Content-Type": "application/json",
        ...resolveHeaders(initialHeaders),
        ...init.headers,
      },
    });

  return {
    async getPromptEligibility(
      params: Readonly<{
        workflow: string;
        relatedEntityType?: string | null;
        relatedEntityId?: string | null;
      }>,
    ): Promise<PlatformFeedbackPromptEligibility> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/platform-feedback/prompt${toQuery(params)}`, { method: "GET" }),
      );
    },
    async submitPlatformFeedback(body: SubmitPlatformFeedbackRequest) {
      return parseJsonResponse<{ id: string; version: number; status: string }>(
        await configuredFetch(`${baseUrl}/platform-feedback`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    },
    async dismissPlatformFeedbackPrompt(body: DismissPlatformFeedbackPromptRequest) {
      return parseJsonResponse<{ id: string; version: number; snoozedUntil: string }>(
        await configuredFetch(`${baseUrl}/platform-feedback/dismiss`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    },
    async listPlatformFeedback(query = ""): Promise<ListResponse<PlatformFeedbackListItem>> {
      return parseJsonResponse(await configuredFetch(`${baseUrl}/platform-feedback${query ? `?${query}` : ""}`));
    },
    async getPlatformFeedback(feedbackId: string): Promise<PlatformFeedbackDetail> {
      return parseJsonResponse(await configuredFetch(`${baseUrl}/platform-feedback/${encodeURIComponent(feedbackId)}`));
    },
    async getPlatformFeedbackMetrics(): Promise<PlatformFeedbackMetrics> {
      return parseJsonResponse(await configuredFetch(`${baseUrl}/platform-feedback/metrics`));
    },
    async markReviewed(feedbackId: string) {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/platform-feedback/${encodeURIComponent(feedbackId)}/review`, {
          method: "POST",
          body: "{}",
        }),
      );
    },
    async archive(feedbackId: string) {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/platform-feedback/${encodeURIComponent(feedbackId)}/archive`, {
          method: "POST",
          body: "{}",
        }),
      );
    },
  };
}

export const experienceApi = createExperienceApiClient();
