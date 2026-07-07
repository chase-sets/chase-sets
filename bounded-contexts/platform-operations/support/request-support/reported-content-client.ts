import { attachResponseMetadata, type ListResponse } from "@chase-sets/http/responses";
import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type {
  ReportedContentQueueDetail,
  ReportedContentQueueItem,
  ReportedContentQueueMetrics,
  ReportedContentModerationAction,
} from "../../features/reported-content/api/contracts";
import { ExperienceApiError } from "./platform-feedback-client";

export type {
  ReportedContentQueueDetail,
  ReportedContentModerationAction,
  ReportedContentQueueItem,
  ReportedContentQueueMetrics,
} from "../../features/reported-content/api/contracts";

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new ExperienceApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

export function createReportedContentApiClient({
  baseUrl = "/api/experience",
  fetch = globalThis.fetch,
}: Readonly<{
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}> = {}) {
  return {
    async listReportedContentQueue(query = ""): Promise<ListResponse<ReportedContentQueueItem>> {
      return parseJsonResponse(await fetch(`${baseUrl}/reported-content${query ? `?${query}` : ""}`));
    },
    async getReportedContentQueueMetrics(): Promise<ReportedContentQueueMetrics> {
      return parseJsonResponse(await fetch(`${baseUrl}/reported-content/metrics`));
    },
    async getReportedContentQueueItem(targetType: string, targetId: string): Promise<ReportedContentQueueDetail> {
      return parseJsonResponse(
        await fetch(`${baseUrl}/reported-content/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}`),
      );
    },
    async recordReportedContentAction(
      targetType: string,
      targetId: string,
      action: ReportedContentModerationAction,
      note: string | null,
    ): Promise<{ id: string; recordedAt: string }> {
      return parseJsonResponse(
        await fetch(
          `${baseUrl}/reported-content/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}/actions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, note }),
          },
        ),
      );
    },
  };
}

export function createReportedContentRequestApiClient(request: Request) {
  return createReportedContentApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/experience"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "platform-operations" }),
  });
}
