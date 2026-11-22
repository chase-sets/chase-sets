import {
  ExperienceApiError,
  parseExperienceApiResponse as parseJsonResponse,
} from "@chase-sets/http/experience-api-response";
import type { CsatAdminDashboardResponse, CsatAdminExportMetadata } from "./analytics-contract";

export function createCsatAdminClient(customerFeedbackBaseUrl: string, configuredFetch: typeof globalThis.fetch) {
  return {
    async getCsatDashboard(query = ""): Promise<CsatAdminDashboardResponse> {
      return parseJsonResponse(
        await configuredFetch(`${customerFeedbackBaseUrl}${query ? `?${query}` : ""}`, { method: "GET" }),
      );
    },
    async createCsatExport(query: string): Promise<Pick<CsatAdminExportMetadata, "exportId" | "rowCount">> {
      const response = await configuredFetch(`${customerFeedbackBaseUrl}/export?${query}`, {
        method: "GET",
        cache: "no-store",
      });
      const metadata = await parseJsonResponse<CsatAdminExportMetadata>(response);
      if (
        response.status !== 201 ||
        metadata.status !== "completed" ||
        typeof metadata.exportId !== "string" ||
        !metadata.exportId ||
        !Number.isInteger(metadata.rowCount) ||
        metadata.rowCount < 0 ||
        !(Date.parse(metadata.artifactExpiresAt) > Date.now())
      ) {
        throw new ExperienceApiError(response.status, "invalid_export_metadata");
      }
      return metadata;
    },
    async downloadCsatExport(exportId: string): Promise<Blob> {
      const response = await configuredFetch(`${customerFeedbackBaseUrl}/export/${encodeURIComponent(exportId)}`, {
        method: "GET",
        cache: "no-store",
      });
      if (response.status !== 200 || response.headers.get("Content-Type")?.split(";")[0]?.trim() !== "text/csv") {
        throw new ExperienceApiError(response.status, "export_download_failed");
      }
      return response.blob();
    },
  };
}
