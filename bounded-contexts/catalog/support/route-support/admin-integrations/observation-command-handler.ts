import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import {
  confirmsFreshPromotionPreview,
  hasExplicitPromotionScope,
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

export type ObservationCommandIntent =
  | "observation.promote"
  | "observation.reject"
  | "observation.defer"
  | "observation.reapply"
  | "observation.replay";

const OBSERVATION_COMMAND_INTENTS = new Set<string>([
  "observation.promote",
  "observation.reject",
  "observation.defer",
  "observation.reapply",
  "observation.replay",
] satisfies ObservationCommandIntent[]);

export function isObservationCommandIntent(intent: string): intent is ObservationCommandIntent {
  return OBSERVATION_COMMAND_INTENTS.has(intent);
}

export async function handleObservationCommand(input: {
  api: Api;
  intent: ObservationCommandIntent;
  context: RouteContext;
  formData: FormData;
  selectedObservationIds: readonly string[];
}): Promise<CatalogIntegrationsCommandResult> {
  const { api, intent, context, formData, selectedObservationIds } = input;

  switch (intent) {
    case "observation.promote":
      return handlePromotion(api, context, formData, selectedObservationIds);
    case "observation.reject":
      return rejectObservations(api, context, formData, selectedObservationIds);
    case "observation.defer":
      return deferObservations(api, context, formData, selectedObservationIds);
    case "observation.reapply":
    case "observation.replay":
      return recoverObservations(api, intent, context, selectedObservationIds);
  }
}

async function handlePromotion(
  api: Api,
  context: RouteContext,
  formData: FormData,
  selectedObservationIds: readonly string[],
): Promise<CatalogIntegrationsCommandResult> {
  const submittedPhase = String(formData.get("promotionPhase") ?? "");
  const phase = submittedPhase || (context.promotionPreviewId ? "execute" : "preview");
  if (phase !== "preview" && phase !== "execute") {
    return observationResult("observation.promote", "error", "invalid-intent", {
      ...context,
      selectedObservationIds,
    });
  }

  if (selectedObservationIds.length === 0 && !hasExplicitPromotionScope(context)) {
    return observationResult(
      "observation.promote",
      "error",
      phase === "preview" ? "command-failed" : "preview-required",
      {
        ...context,
        selectedObservationIds,
        promotionPreviewId: null,
      },
    );
  }

  if (phase === "preview") {
    const preview = await previewPromotionForContext(api, context, selectedObservationIds);
    return observationResult("observation.promote", "success", "preview-ready", {
      ...context,
      selectedObservationIds,
      promotionPreviewId: promotionPreviewIdFor(preview, context, selectedObservationIds),
    });
  }

  if (!context.promotionPreviewId || !(await confirmsFreshPromotionPreview(api, context, selectedObservationIds))) {
    return observationResult("observation.promote", "error", "preview-required", {
      ...context,
      selectedObservationIds,
      promotionPreviewId: null,
    });
  }

  const job =
    selectedObservationIds.length > 0
      ? await api.bulkPromoteSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
      : await api.bulkPromoteSourceObservationsByScope<CatalogCommandJobResponse>(promotionScopeFromContext(context));
  return observationResult("observation.promote", "success", "job-queued", {
    ...context,
    jobId: stringValue(job.jobId) ?? context.jobId,
    promotionPreviewId: null,
  });
}

async function rejectObservations(
  api: Api,
  context: RouteContext,
  formData: FormData,
  selectedObservationIds: readonly string[],
): Promise<CatalogIntegrationsCommandResult> {
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) {
    return observationResult("observation.reject", "error", "reason-required", {
      ...context,
      selectedObservationIds,
    });
  }
  const job =
    selectedObservationIds.length > 0
      ? await api.bulkRejectSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds], reason)
      : await api.bulkRejectSourceObservationsByScope<CatalogCommandJobResponse>(
          promotionScopeFromContext(context),
          reason,
        );
  return observationResult("observation.reject", "success", "job-queued", {
    ...context,
    selectedObservationIds,
    jobId: stringValue(job.jobId) ?? context.jobId,
    promotionPreviewId: null,
  });
}

async function deferObservations(
  api: Api,
  context: RouteContext,
  formData: FormData,
  selectedObservationIds: readonly string[],
): Promise<CatalogIntegrationsCommandResult> {
  const reason = String(formData.get("reason") ?? "").trim() || "Deferred from the primary workbench.";
  const job =
    selectedObservationIds.length > 0
      ? await api.deferSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds], reason)
      : await api.deferSourceObservationsByScope<CatalogCommandJobResponse>(promotionScopeFromContext(context), reason);
  return observationResult("observation.defer", "success", "job-queued", {
    ...context,
    selectedObservationIds: [],
    jobId: stringValue(job.jobId) ?? context.jobId,
    promotionPreviewId: null,
  });
}

async function recoverObservations(
  api: Api,
  intent: Extract<ObservationCommandIntent, "observation.reapply" | "observation.replay">,
  context: RouteContext,
  selectedObservationIds: readonly string[],
): Promise<CatalogIntegrationsCommandResult> {
  const job =
    intent === "observation.reapply"
      ? selectedObservationIds.length > 0
        ? await api.reapplySourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
        : await api.reapplySourceObservationsByScope<CatalogCommandJobResponse>(reapplyScopeFromContext(context))
      : selectedObservationIds.length > 0
        ? await api.replaySourceObservations<CatalogCommandJobResponse>([...selectedObservationIds])
        : await api.replaySourceObservationsByScope<CatalogCommandJobResponse>(reapplyScopeFromContext(context));
  return observationResult(intent, "success", "job-queued", {
    ...context,
    selectedObservationIds,
    jobId: stringValue(job.jobId) ?? context.jobId,
    promotionPreviewId: null,
  });
}

function observationResult(
  intent: ObservationCommandIntent,
  status: CatalogIntegrationsCommandResult["feedback"]["status"],
  result: CatalogIntegrationsCommandResult["feedback"]["result"],
  context: RouteContext,
): CatalogIntegrationsCommandResult {
  return { feedback: { status, intent, result }, context, section: "import-to-promotion" };
}
