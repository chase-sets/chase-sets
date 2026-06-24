import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";
import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import {
  catalogSyncScopeFromContext,
  confirmsFreshPromotionPreview,
  hasExplicitPromotionScope,
  integrationScopeFromContext,
  previewPromotionForContext,
  promotionPreviewIdFor,
  promotionScopeFromContext,
  reapplyScopeFromContext,
  type CatalogCommandJobResponse,
} from "./integrations-command-context";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";
import { stringValue } from "./integrations-form-values";

type Api = ReturnType<typeof createCatalogRequestApiClient>;
type RouteContext = CatalogIntegrationsCommandResult["context"];

// The daily import-to-promotion surface owns the run-sync / create-update flow and
// the Source Observation review wave. Every daily intent stays on the daily route:
// the handler returns a structured result with the import-to-promotion section, and
// the surface renders the command-feedback banner without navigating away.
export type DailyCommandIntent =
  | "start-catalog-sync"
  | "start-provider-import"
  | "retry-import-job"
  | "resume-import-job"
  | "cancel-import-job"
  | "preview-promotion"
  | "execute-promotion"
  | "reject-source-observations"
  | "defer-source-observations"
  | "start-reapply"
  | "start-replay";

const DAILY_COMMAND_INTENTS = new Set<string>([
  "start-catalog-sync",
  "start-provider-import",
  "retry-import-job",
  "resume-import-job",
  "cancel-import-job",
  "preview-promotion",
  "execute-promotion",
  "reject-source-observations",
  "defer-source-observations",
  "start-reapply",
  "start-replay",
] satisfies DailyCommandIntent[]);

export function isDailyCommandIntent(intent: string): intent is DailyCommandIntent {
  return DAILY_COMMAND_INTENTS.has(intent);
}

// Run a daily command. Splits the import-job lifecycle, promotion preview/execution,
// and observation-review intents into cohesive blocks. The result always names the
// import-to-promotion section so the daily surface stays put with a status banner.
export async function handleDailyCommand(input: {
  api: Api;
  intent: DailyCommandIntent;
  context: RouteContext;
  formData: FormData;
  selectedObservationIds: readonly string[];
}): Promise<CatalogIntegrationsCommandResult> {
  const { api, intent, context, formData, selectedObservationIds } = input;

  switch (intent) {
    case "start-catalog-sync": {
      const scope = catalogSyncScopeFromContext(context, formData);
      if (!scope) {
        return dailyResult(intent, "error", "command-failed", { ...context, jobId: null, promotionPreviewId: null });
      }

      const run = await api.enqueueCatalogSyncRun<{ syncRunId?: unknown }>(scope);

      return dailyResult(intent, "success", "job-queued", {
        ...context,
        jobId: stringValue(run.syncRunId) ?? context.jobId,
        promotionPreviewId: null,
      });
    }
    case "start-provider-import": {
      if (!hasSelectedImportScope(context)) {
        return dailyResult(intent, "error", "command-failed", { ...context, jobId: null, promotionPreviewId: null });
      }

      const job = await api.enqueueSourceObservationIntegrationJob<CatalogCommandJobResponse>(
        "import",
        integrationScopeFromContext(context),
      );

      return dailyResult(intent, "success", "job-queued", {
        ...context,
        jobId: stringValue(job.jobId) ?? context.jobId,
        promotionPreviewId: null,
      });
    }
    case "retry-import-job":
    case "resume-import-job":
    case "cancel-import-job": {
      if (!context.jobId) {
        return dailyResult(intent, "error", "job-required", { ...context, selectedObservationIds });
      }

      const job =
        intent === "retry-import-job"
          ? await api.retrySourceObservationIntegrationJob<CatalogCommandJobResponse>(context.jobId)
          : intent === "resume-import-job"
            ? await api.resumeSourceObservationIntegrationJob<CatalogCommandJobResponse>(context.jobId)
            : await api.cancelSourceObservationIntegrationJob<CatalogCommandJobResponse>(context.jobId);

      return dailyResult(intent, "success", intent === "cancel-import-job" ? "job-cancelled" : "job-queued", {
        ...context,
        selectedObservationIds,
        jobId: stringValue(job.jobId) ?? context.jobId,
        promotionPreviewId: null,
      });
    }
    case "preview-promotion": {
      if (selectedObservationIds.length === 0 && !hasExplicitPromotionScope(context)) {
        return dailyResult(intent, "error", "command-failed", {
          ...context,
          selectedObservationIds,
          promotionPreviewId: null,
        });
      }

      const preview = await previewPromotionForContext(api, context, selectedObservationIds);

      return dailyResult(intent, "success", "preview-ready", {
        ...context,
        selectedObservationIds,
        promotionPreviewId: promotionPreviewIdFor(preview, context, selectedObservationIds),
      });
    }
    case "execute-promotion": {
      if (selectedObservationIds.length === 0 && !hasExplicitPromotionScope(context)) {
        return dailyResult(intent, "error", "preview-required", {
          ...context,
          selectedObservationIds,
          promotionPreviewId: null,
        });
      }
      if (!context.promotionPreviewId || !(await confirmsFreshPromotionPreview(api, context, selectedObservationIds))) {
        return dailyResult(intent, "error", "preview-required", {
          ...context,
          selectedObservationIds,
          promotionPreviewId: null,
        });
      }

      const job =
        selectedObservationIds.length > 0
          ? await api.bulkPromoteSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
          : await api.bulkPromoteSourceObservationsByScope<CatalogCommandJobResponse>(
              promotionScopeFromContext(context),
            );

      return dailyResult(intent, "success", "job-queued", {
        ...context,
        jobId: stringValue(job.jobId) ?? context.jobId,
        promotionPreviewId: null,
      });
    }
    case "reject-source-observations": {
      const reason = String(formData.get("reason") ?? "").trim();
      if (!reason) {
        return dailyResult(intent, "error", "reason-required", { ...context, selectedObservationIds });
      }

      const job =
        selectedObservationIds.length > 0
          ? await api.bulkRejectSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds], reason)
          : await api.bulkRejectSourceObservationsByScope<CatalogCommandJobResponse>(
              promotionScopeFromContext(context),
              reason,
            );

      return dailyResult(intent, "success", "job-queued", {
        ...context,
        selectedObservationIds,
        jobId: stringValue(job.jobId) ?? context.jobId,
        promotionPreviewId: null,
      });
    }
    case "defer-source-observations": {
      const reason = String(formData.get("reason") ?? "").trim() || "Deferred from the primary workbench.";
      const job =
        selectedObservationIds.length > 0
          ? await api.deferSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds], reason)
          : await api.deferSourceObservationsByScope<CatalogCommandJobResponse>(
              promotionScopeFromContext(context),
              reason,
            );

      return dailyResult(intent, "success", "job-queued", {
        ...context,
        selectedObservationIds: [],
        jobId: stringValue(job.jobId) ?? context.jobId,
        promotionPreviewId: null,
      });
    }
    case "start-reapply":
    case "start-replay": {
      const job =
        intent === "start-reapply"
          ? selectedObservationIds.length > 0
            ? await api.reapplySourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
            : await api.reapplySourceObservationsByScope<CatalogCommandJobResponse>(reapplyScopeFromContext(context))
          : selectedObservationIds.length > 0
            ? await api.replaySourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
            : await api.replaySourceObservationsByScope<CatalogCommandJobResponse>(reapplyScopeFromContext(context));

      return dailyResult(intent, "success", "job-queued", {
        ...context,
        selectedObservationIds,
        jobId: stringValue(job.jobId) ?? context.jobId,
        promotionPreviewId: null,
      });
    }
  }
}

function hasSelectedImportScope(context: RouteContext): boolean {
  return Boolean(context.providerKey && context.unitKey && context.importScope);
}

// Every daily result names the import-to-promotion section, so the daily surface
// stays on its route and renders the command-feedback banner.
function dailyResult(
  intent: DailyCommandIntent,
  status: CatalogPrimaryWorkbenchCommandFeedback["status"],
  result: CatalogPrimaryWorkbenchCommandFeedback["result"],
  context: RouteContext,
): CatalogIntegrationsCommandResult {
  return {
    feedback: { status, intent, result },
    context,
    section: "import-to-promotion",
  };
}
