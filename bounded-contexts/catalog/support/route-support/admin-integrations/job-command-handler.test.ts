import { describe, expect, it, vi } from "vitest";
import { handleJobCommand, isJobCommandIntent } from "./job-command-handler";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";

describe("import-job entity command handler", () => {
  it("recognizes only the import-job lifecycle intents", () => {
    expect(isJobCommandIntent("retry-import-job")).toBe(true);
    expect(isJobCommandIntent("resume-import-job")).toBe(true);
    expect(isJobCommandIntent("cancel-import-job")).toBe(true);
    expect(isJobCommandIntent("start-catalog-sync")).toBe(false);
    expect(isJobCommandIntent("preview-promotion")).toBe(false);
  });

  it("retries the durable import job and stays on the daily surface with a queued banner", async () => {
    const retrySourceObservationIntegrationJob = vi.fn(async () => ({ jobId: "job_import_9" }));

    const result = await handleJobCommand({
      api: { retrySourceObservationIntegrationJob } as never,
      intent: "retry-import-job",
      context: commandContext({ jobId: "job_import_1" }),
      selectedObservationIds: ["obs_1"],
    });

    expect(retrySourceObservationIntegrationJob).toHaveBeenCalledWith("job_import_1");
    expect(result.section).toBe("import-to-promotion");
    expect(result.feedback).toMatchObject({ status: "success", intent: "retry-import-job", result: "job-queued" });
    expect(result.context.jobId).toBe("job_import_9");
    expect(result.context.selectedObservationIds).toEqual(["obs_1"]);
    expect(result.context.promotionPreviewId).toBeNull();
  });

  it("reports a cancelled lifecycle transition with its own result", async () => {
    const cancelSourceObservationIntegrationJob = vi.fn(async () => ({ jobId: "job_import_1" }));

    const result = await handleJobCommand({
      api: { cancelSourceObservationIntegrationJob } as never,
      intent: "cancel-import-job",
      context: commandContext({ jobId: "job_import_1" }),
      selectedObservationIds: [],
    });

    expect(cancelSourceObservationIntegrationJob).toHaveBeenCalledWith("job_import_1");
    expect(result.feedback).toMatchObject({ intent: "cancel-import-job", result: "job-cancelled" });
  });

  it("fails closed without a durable job id to act on", async () => {
    const retrySourceObservationIntegrationJob = vi.fn();

    const result = await handleJobCommand({
      api: { retrySourceObservationIntegrationJob } as never,
      intent: "retry-import-job",
      context: commandContext({ jobId: null }),
      selectedObservationIds: [],
    });

    expect(retrySourceObservationIntegrationJob).not.toHaveBeenCalled();
    expect(result.feedback).toMatchObject({ status: "error", result: "job-required" });
  });
});

function commandContext(
  overrides: Partial<CatalogIntegrationsCommandResult["context"]>,
): CatalogIntegrationsCommandResult["context"] {
  return {
    section: "import-to-promotion",
    providerKey: "tcgdex",
    unitKey: "tcgdex:pokemon:card:import",
    scope: undefined,
    importScope: "en:3:base:base1",
    profileVersion: "2026.06.04",
    sourceObservationFilters: {},
    selectedObservationIds: [],
    reviewOffset: null,
    reviewLimit: null,
    jobId: null,
    promotionPreviewId: null,
    returnPath: null,
    ...overrides,
  };
}
