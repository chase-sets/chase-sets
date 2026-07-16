import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import { type CatalogCommandJobResponse } from "./integrations-command-context";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";
import { stringValue } from "./integrations-form-values";

type Api = ReturnType<typeof createCatalogRequestApiClient>;
type RouteContext = CatalogIntegrationsCommandResult["context"];

// The import-job entity owns the durable-job lifecycle transitions the operator
// drives from the import-jobs module and the sync-scope workset: retry a failed
// run, resume a paused one, or cancel one in flight. These are the `job` entity
// actions in the Catalog Control Plane v2 vocabulary (`job.retry` | `job.resume`
// | `job.cancel`); each command handler remains responsible for one entity. Every
// transition targets one
// durable import job and stays on the daily import-to-promotion surface: the
// result names that section and the surface renders a status banner in place.
export type JobCommandIntent = "job.retry" | "job.resume" | "job.cancel";

const JOB_COMMAND_INTENTS = new Set<string>(["job.retry", "job.resume", "job.cancel"] satisfies JobCommandIntent[]);

export function isJobCommandIntent(intent: string): intent is JobCommandIntent {
  return JOB_COMMAND_INTENTS.has(intent);
}

export async function handleJobCommand(input: {
  api: Api;
  intent: JobCommandIntent;
  context: RouteContext;
  selectedObservationIds: readonly string[];
}): Promise<CatalogIntegrationsCommandResult> {
  const { api, intent, context, selectedObservationIds } = input;

  // A lifecycle transition acts on one durable import job; without its id there is
  // nothing to transition, so the surface asks the operator to pick a job first.
  if (!context.jobId) {
    return jobResult(intent, "error", "job-required", { ...context, selectedObservationIds });
  }

  const job = await runJobLifecycleTransition(api, intent, context.jobId);

  return jobResult(intent, "success", intent === "job.cancel" ? "job-cancelled" : "job-queued", {
    ...context,
    selectedObservationIds,
    jobId: stringValue(job.jobId) ?? context.jobId,
    promotionPreviewId: null,
  });
}

function runJobLifecycleTransition(
  api: Api,
  intent: JobCommandIntent,
  jobId: string,
): Promise<CatalogCommandJobResponse> {
  switch (intent) {
    case "job.retry":
      return api.retrySourceObservationIntegrationJob<CatalogCommandJobResponse>(jobId);
    case "job.resume":
      return api.resumeSourceObservationIntegrationJob<CatalogCommandJobResponse>(jobId);
    case "job.cancel":
      return api.cancelSourceObservationIntegrationJob<CatalogCommandJobResponse>(jobId);
  }
}

function jobResult(
  intent: JobCommandIntent,
  status: CatalogIntegrationsCommandResult["feedback"]["status"],
  result: CatalogIntegrationsCommandResult["feedback"]["result"],
  context: RouteContext,
): CatalogIntegrationsCommandResult {
  return {
    feedback: { status, intent, result },
    context,
    section: "import-to-promotion",
  };
}
