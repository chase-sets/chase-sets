import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import {
  catalogSyncScopeFromContext,
  integrationScopeFromContext,
  type CatalogCommandJobResponse,
} from "./integrations-command-context";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";
import { stringValue } from "./integrations-form-values";

type Api = ReturnType<typeof createCatalogRequestApiClient>;
type RouteContext = CatalogIntegrationsCommandResult["context"];

export type ScopeCommandIntent = "scope.sync" | "scope.import";

export function isScopeCommandIntent(intent: string): intent is ScopeCommandIntent {
  return intent === "scope.sync" || intent === "scope.import";
}

export async function handleScopeCommand(input: {
  api: Api;
  intent: ScopeCommandIntent;
  context: RouteContext;
  formData: FormData;
}): Promise<CatalogIntegrationsCommandResult> {
  const { api, intent, context, formData } = input;

  if (intent === "scope.sync") {
    const scope = catalogSyncScopeFromContext(context, formData);
    if (!scope) {
      return scopeResult(intent, "error", "command-failed", { ...context, jobId: null, promotionPreviewId: null });
    }
    const run = await api.enqueueCatalogSyncRun<{ syncRunId?: unknown }>(scope);
    return scopeResult(intent, "success", "job-queued", {
      ...context,
      jobId: stringValue(run.syncRunId) ?? context.jobId,
      promotionPreviewId: null,
    });
  }

  if (!context.providerKey || !context.unitKey || !context.importScope) {
    return scopeResult(intent, "error", "command-failed", { ...context, jobId: null, promotionPreviewId: null });
  }
  const scope = integrationScopeFromContext(context);
  const job = await api.enqueueSourceObservationIntegrationJob<CatalogCommandJobResponse>("import", scope);
  return {
    ...scopeResult(intent, "success", "job-queued", {
      ...context,
      jobId: stringValue(job.jobId) ?? context.jobId,
      promotionPreviewId: null,
    }),
    // Only the producer's scalars identify the returned job. Context retains its
    // existing handoff semantics, but is never the receipt's identity fallback.
    importJobReceipt: {
      schemaVersion: "source-observation-import-job-receipt/v1",
      jobId: typeof job.jobId === "string" && job.jobId.trim() ? job.jobId : null,
      status: typeof job.status === "string" && job.status.trim() ? job.status : null,
      scope,
      submitted: {
        providerKey: context.providerKey,
        unitKey: context.unitKey,
        profileVersion: context.profileVersion,
      },
    },
  };
}

function scopeResult(
  intent: ScopeCommandIntent,
  status: CatalogIntegrationsCommandResult["feedback"]["status"],
  result: CatalogIntegrationsCommandResult["feedback"]["result"],
  context: RouteContext,
): CatalogIntegrationsCommandResult {
  return { feedback: { status, intent, result }, context, section: "import-to-promotion" };
}
