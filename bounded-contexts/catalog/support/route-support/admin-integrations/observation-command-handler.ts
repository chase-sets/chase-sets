import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import {
  isStalePromotionPreviewError,
  observationDecisionScopeFromContext,
  reapplyScopeFromContext,
  type CatalogCommandJobResponse,
} from "./integrations-command-context";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";
import { stringValue } from "./integrations-form-values";
import { projectPromotionReceipt } from "../../../features/source-observations/ui/primary-workbench-source-observation-review";
import { serializeCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";
import type {
  CatalogPrimaryWorkbenchPromotionCommandPreview,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import type { SourceObservationPromotionPreview } from "../../../features/source-observations/ui/contracts";

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

  const unavailable = () =>
    observationResult("observation.promote", "error", phase === "preview" ? "command-failed" : "preview-required", {
      ...context,
      selectedObservationIds,
      promotionPreviewId: null,
    });
  let commandPreview: CatalogPrimaryWorkbenchPromotionCommandPreview | undefined;
  try {
    // Read the effective submitted row, never a posted descriptor or loader closure.
    // Do not send the held token: the read must not request another preview.
    const location = `/catalog/integrations?${serializeCatalogPrimaryWorkbenchRouteContext({ ...context, promotionPreviewId: null, jobId: null })}`;
    const answer = await api.getCatalogPrimaryWorkbenchSurface<{ readModel: CatalogPrimaryWorkbenchReadModel }>(
      "daily",
      location,
    );
    commandPreview = answer?.readModel?.actions?.find((entry) => entry.key === "observation.promote")?.commandPreview;
  } catch {
    return unavailable();
  }
  if (!commandPreview || (selectedObservationIds.length === 0 && !commandPreview.allowScopeSelection)) {
    return unavailable();
  }

  // `context.promoteAsDraft` already reflects the submitted form choice (see
  // commandContextFromFormData). The Catalog API binds it into the preview
  // token, so an execution whose choice differs from the previewed one is
  // refused there and must re-preview.
  const promoteAsDraft = context.promoteAsDraft === true;
  const previewRequired = () =>
    observationResult("observation.promote", "error", "preview-required", {
      ...context,
      selectedObservationIds,
      promoteAsDraft,
      promotionPreviewId: null,
    });
  if (phase === "preview") {
    const options = { promoteAsDraft, confirmation: commandPreview.confirmation };
    const preview =
      selectedObservationIds.length > 0
        ? await api.previewBulkPromoteSourceObservationIds<SourceObservationPromotionPreview>(
            [...selectedObservationIds],
            options,
          )
        : await api.previewBulkPromoteSourceObservations<SourceObservationPromotionPreview>(
            commandPreview.scope,
            options,
          );
    // A first-page preview always carries the Catalog API's token; without
    // one the execution is refused and asks for a preview again.
    const previewId = preview.previewToken ?? "";
    const result = observationResult("observation.promote", "success", "preview-ready", {
      ...context,
      selectedObservationIds,
      promoteAsDraft,
      promotionPreviewId: previewId,
    });
    return {
      ...result,
      promotionCommandPreview: commandPreview,
      promotionReceipt: projectPromotionReceipt({
        schemaVersion: "source-observation-promotion-receipt/v1",
        previewId,
        selection: {
          providerKey: context.providerKey,
          unitKey: context.unitKey,
          importScope: context.importScope,
          profileVersion: context.profileVersion,
          scopeRecordId: context.scopeRecordId ?? null,
          observationIds: selectedObservationIds,
          promoteAsDraft,
          scope: commandPreview.scope,
        },
        preview,
      }),
    };
  }

  if (!context.promotionPreviewId) {
    return previewRequired();
  }

  const options = {
    promoteAsDraft,
    previewToken: context.promotionPreviewId,
    confirmation: commandPreview.confirmation,
  };
  let job: CatalogCommandJobResponse;
  try {
    job =
      selectedObservationIds.length > 0
        ? await api.bulkPromoteSourceObservations<CatalogCommandJobResponse>([...selectedObservationIds], options)
        : await api.bulkPromoteSourceObservationsByScope<CatalogCommandJobResponse>(commandPreview.scope, options);
  } catch (error) {
    if (isStalePromotionPreviewError(error)) {
      return previewRequired();
    }
    throw error;
  }
  return observationResult("observation.promote", "success", "job-queued", {
    ...context,
    jobId: stringValue(job.jobId) ?? context.jobId,
    promoteAsDraft: false,
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
          observationDecisionScopeFromContext(context),
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
      : await api.deferSourceObservationsByScope<CatalogCommandJobResponse>(
          observationDecisionScopeFromContext(context),
          reason,
        );
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
