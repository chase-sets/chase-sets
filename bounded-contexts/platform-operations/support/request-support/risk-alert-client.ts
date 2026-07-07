import { attachResponseMetadata, type ListResponse } from "@chase-sets/http/responses";
import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type {
  RiskAlertAction,
  RiskAlertQueueDetail,
  RiskAlertQueueItem,
  RiskAlertQueueMetrics,
} from "../../features/risk-alerts/api/contracts";
import { ExperienceApiError } from "./platform-feedback-client";

export type { RiskAlertAction, RiskAlertQueueDetail, RiskAlertQueueItem, RiskAlertQueueMetrics };

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new ExperienceApiError(response.status, errorBody);
  }
  return attachResponseMetadata(await response.json(), response) as T;
}

export function createRiskAlertApiClient({
  baseUrl = "/api/experience",
  fetch = globalThis.fetch,
}: Readonly<{ baseUrl?: string; fetch?: typeof globalThis.fetch }> = {}) {
  return {
    async listRiskAlertQueue(query = ""): Promise<ListResponse<RiskAlertQueueItem>> {
      return parseJsonResponse(await fetch(`${baseUrl}/risk-alerts${query ? `?${query}` : ""}`));
    },
    async getRiskAlertQueueMetrics(): Promise<RiskAlertQueueMetrics> {
      return parseJsonResponse(await fetch(`${baseUrl}/risk-alerts/metrics`));
    },
    async getRiskAlertQueueItem(alertId: string): Promise<RiskAlertQueueDetail> {
      return parseJsonResponse(await fetch(`${baseUrl}/risk-alerts/${encodeURIComponent(alertId)}`));
    },
    async recordRiskAlertAction(
      alertId: string,
      action: RiskAlertAction,
      note: string | null,
    ): Promise<{ id: string; recordedAt: string }> {
      return parseJsonResponse(
        await fetch(`${baseUrl}/risk-alerts/${encodeURIComponent(alertId)}/actions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, note }),
        }),
      );
    },
  };
}

export function createRiskAlertRequestApiClient(request: Request) {
  return createRiskAlertApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/experience"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "platform-operations" }),
  });
}
