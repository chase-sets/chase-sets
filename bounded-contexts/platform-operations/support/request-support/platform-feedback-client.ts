import { createCsatAdminClient } from "@chase-sets/customer-feedback/server";
import { parseExperienceApiResponse as parseJsonResponse } from "@chase-sets/http/experience-api-response";
import type { ListResponse } from "@chase-sets/http/responses";
import type {
  DismissPlatformFeedbackPromptRequest,
  PlatformFeedbackDetail,
  PlatformFeedbackListItem,
  PlatformFeedbackMetrics,
  PlatformFeedbackBulkActionRequest,
  PlatformFeedbackBulkActionSnapshot,
  PlatformFeedbackOperatorNoteSnapshot,
  PlatformFeedbackPromptEligibility,
  PlatformFeedbackPromptDismissalSnapshot,
  PlatformFeedbackReviewSnapshot,
  PlatformFeedbackSubmissionSnapshot,
  RecordPlatformFeedbackOperatorNoteRequest,
  SubmitPlatformFeedbackRequest,
} from "../../features/platform-feedback/api/contracts";

const DEFAULT_BASE_URL = "/api/experience";

export type {
  DismissPlatformFeedbackPromptRequest,
  PlatformFeedbackDetail,
  PlatformFeedbackListItem,
  PlatformFeedbackMetrics,
  PlatformFeedbackBulkActionRequest,
  PlatformFeedbackBulkActionSnapshot,
  PlatformFeedbackOperatorNoteSnapshot,
  PlatformFeedbackPromptEligibility,
  PlatformFeedbackPromptDismissalSnapshot,
  PlatformFeedbackReviewSnapshot,
  PlatformFeedbackSubmissionSnapshot,
  RecordPlatformFeedbackOperatorNoteRequest,
  SubmitPlatformFeedbackRequest,
} from "../../features/platform-feedback/api/contracts";
export type {
  CsatAdminQueueFilters,
  CsatAdminQueuePage,
  CsatAnalyticsSnapshot,
} from "@chase-sets/customer-feedback/server";

export { ExperienceApiError } from "@chase-sets/http/experience-api-response";

export interface ExperienceApiClientOptions {
  baseUrl?: string;
  customerFeedbackBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
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
  customerFeedbackBaseUrl = "/api/customer-feedback",
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
    ...createCsatAdminClient(customerFeedbackBaseUrl, configuredFetch),
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
      return parseJsonResponse<PlatformFeedbackSubmissionSnapshot>(
        await configuredFetch(`${baseUrl}/platform-feedback`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    },
    async dismissPlatformFeedbackPrompt(body: DismissPlatformFeedbackPromptRequest) {
      return parseJsonResponse<PlatformFeedbackPromptDismissalSnapshot>(
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
      return parseJsonResponse<PlatformFeedbackReviewSnapshot>(
        await configuredFetch(`${baseUrl}/platform-feedback/${encodeURIComponent(feedbackId)}/review`, {
          method: "POST",
          body: "{}",
        }),
      );
    },
    async archive(feedbackId: string) {
      return parseJsonResponse<PlatformFeedbackReviewSnapshot>(
        await configuredFetch(`${baseUrl}/platform-feedback/${encodeURIComponent(feedbackId)}/archive`, {
          method: "POST",
          body: "{}",
        }),
      );
    },
    async recordOperatorNote(feedbackId: string, body: RecordPlatformFeedbackOperatorNoteRequest) {
      return parseJsonResponse<PlatformFeedbackOperatorNoteSnapshot>(
        await configuredFetch(`${baseUrl}/platform-feedback/${encodeURIComponent(feedbackId)}/notes`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    },
    async bulkMarkReviewed(body: PlatformFeedbackBulkActionRequest) {
      return parseJsonResponse<PlatformFeedbackBulkActionSnapshot>(
        await configuredFetch(`${baseUrl}/platform-feedback/bulk/review`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    },
    async bulkArchive(body: PlatformFeedbackBulkActionRequest) {
      return parseJsonResponse<PlatformFeedbackBulkActionSnapshot>(
        await configuredFetch(`${baseUrl}/platform-feedback/bulk/archive`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    },
  };
}

export const experienceApi = createExperienceApiClient();
