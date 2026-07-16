import type { ActionFunctionArgs } from "react-router";
import {
  commandTelemetryEvents,
  recordCatalogControlPlaneEvents,
  type CatalogControlPlaneTelemetryApi,
} from "../../../features/source-observations/ui/primary-workbench-telemetry";
import { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import { commandContextFromFormData, observationIdsFromFormData } from "./integrations-command-context";
import { CatalogApiError } from "../../../client";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";
import { handleAliasReviewCommand, isAliasReviewCommandIntent } from "./alias-review-command-handler";
import { handleAttentionQueueCommand, isAttentionQueueCommandIntent } from "./attention-queue-command-handler";
import { handleCandidateCommand, isCandidateCommandIntent } from "./candidate-command-handler";
import { handleJobCommand, isJobCommandIntent } from "./job-command-handler";
import { handleObservationCommand, isObservationCommandIntent } from "./observation-command-handler";
import { handleProviderProfileCommand, isProviderProfileCommandIntent } from "./provider-profile-command-handler";
import { handleScopeCommand, isScopeCommandIntent } from "./scope-command-handler";
import {
  CATALOG_CONTROL_PLANE_ACTIONS,
  type CatalogControlPlaneAction,
  type CatalogControlPlaneActionId,
  type CatalogControlPlaneEntityKey,
} from "../../../features/source-observations/ui/admin-control-plane/information-architecture-v2";

// The integrations command dispatcher. It is the single result-routing point for
// every Catalog control-plane command: it accepts only the per-entity
// `${entity}.${verb}` vocabulary, routes the action to its entity handler, records
// telemetry, and returns one structured result. It does not navigate; route entry
// points derive any redirect from the result.
export async function dispatchIntegrationsCommand({
  request,
}: ActionFunctionArgs): Promise<CatalogIntegrationsCommandResult> {
  const api = createCatalogRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "");
  const context = commandContextFromFormData(request.url, formData);
  const selectedObservationIds = observationIdsFromFormData(formData, context.selectedObservationIds);
  const controlPlaneAction = catalogControlPlaneActionForIntent(intent);

  const routedResult =
    controlPlaneAction || isAttentionQueueCommandIntent(intent)
      ? await runIntegrationsCommand({
          api,
          action: controlPlaneAction,
          intent,
          context,
          formData,
          selectedObservationIds,
        })
      : invalidIntentResult(intent, context, selectedObservationIds);
  const result = controlPlaneAction
    ? withUniformFeedback(routedResult, controlPlaneAction, formData, selectedObservationIds)
    : routedResult;
  await recordCommandTelemetry(api, result);

  return result;
}

function withUniformFeedback(
  result: CatalogIntegrationsCommandResult,
  action: CatalogControlPlaneAction,
  formData: FormData,
  selectedObservationIds: readonly string[],
): CatalogIntegrationsCommandResult {
  const targetIds = commandTargetIds(action, result, formData, selectedObservationIds);
  return {
    ...result,
    feedback: {
      ...result.feedback,
      intent: action.id,
      target: {
        entity: action.entity,
        id: targetIds.at(0) ?? null,
        count: targetIds.length,
      },
      nextStep: commandNextStep(result.feedback.result),
      undoAction: null,
    },
  };
}

function commandTargetIds(
  action: CatalogControlPlaneAction,
  result: CatalogIntegrationsCommandResult,
  formData: FormData,
  selectedObservationIds: readonly string[],
): readonly string[] {
  if (action.entity === "scope") {
    return compactIds(formData.get("scopeRecordId"), formData.get("referenceId"), result.context.importScope).slice(
      0,
      1,
    );
  }
  if (action.entity === "job") {
    return compactIds(result.context.jobId);
  }
  if (action.entity === "observation") {
    return selectedObservationIds.length > 0 ? selectedObservationIds : compactIds(result.context.importScope);
  }
  if (action.entity === "candidate") {
    return compactIds(formData.get("candidateId"), ...String(formData.get("bulkCandidateIds") ?? "").split(","));
  }
  if (action.entity === "alias") {
    return compactIds(...String(formData.get("aliasHashes") ?? "").split(","));
  }
  return compactIds(
    result.context.providerKey && result.context.profileVersion
      ? `${result.context.providerKey}:${result.context.profileVersion}`
      : result.context.providerKey,
  );
}

function compactIds(...values: unknown[]): readonly string[] {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function commandNextStep(
  result: CatalogPrimaryWorkbenchCommandFeedback["result"],
): CatalogPrimaryWorkbenchCommandFeedback["nextStep"] {
  if (result === "preview-ready") {
    return "review-and-confirm";
  }
  if (result === "preview-required") {
    return "re-preview";
  }
  if (result === "job-queued") {
    return "monitor-job";
  }
  if (result.endsWith("required") || result === "invalid-intent") {
    return "correct-input";
  }
  return null;
}

// Resolve a submitted action id directly. Retired page-scoped intent strings are
// deliberately not translated.
export function catalogControlPlaneActionForIntent(intent: string): CatalogControlPlaneAction | undefined {
  return CATALOG_CONTROL_PLANE_ACTIONS.find((action) => action.id === intent);
}

export function catalogControlPlaneCommandRouteForAction(
  actionId: CatalogControlPlaneActionId,
): CatalogControlPlaneEntityKey {
  const action = catalogControlPlaneActionForIntent(actionId);
  if (!action) {
    throw new Error(`Unknown Catalog control-plane action '${actionId}'.`);
  }
  return action.entity;
}

function invalidIntentResult(
  intent: string,
  context: ReturnType<typeof commandContextFromFormData>,
  selectedObservationIds: readonly string[],
): CatalogIntegrationsCommandResult {
  return {
    feedback: { status: "error", intent, result: "invalid-intent" },
    context: { ...context, selectedObservationIds },
    section: context.section,
  };
}

async function runIntegrationsCommand(input: {
  api: ReturnType<typeof createCatalogRequestApiClient>;
  action: CatalogControlPlaneAction | undefined;
  intent: string;
  context: ReturnType<typeof commandContextFromFormData>;
  formData: FormData;
  selectedObservationIds: readonly string[];
}): Promise<CatalogIntegrationsCommandResult> {
  const { api, action, intent, context, formData, selectedObservationIds } = input;

  try {
    if (isAttentionQueueCommandIntent(intent)) {
      return await handleAttentionQueueCommand({ api, intent, context, formData });
    }
    if (!action) {
      return invalidIntentResult(intent, context, selectedObservationIds);
    }

    switch (action.entity) {
      case "alias":
        return isAliasReviewCommandIntent(intent)
          ? await handleAliasReviewCommand({ api, intent, context, formData })
          : invalidIntentResult(intent, context, selectedObservationIds);
      case "job":
        return isJobCommandIntent(intent)
          ? await handleJobCommand({ api, intent, context, selectedObservationIds })
          : invalidIntentResult(intent, context, selectedObservationIds);
      case "scope":
        return isScopeCommandIntent(intent)
          ? await handleScopeCommand({ api, intent, context, formData })
          : invalidIntentResult(intent, context, selectedObservationIds);
      case "observation":
        return isObservationCommandIntent(intent)
          ? await handleObservationCommand({ api, intent, context, formData, selectedObservationIds })
          : invalidIntentResult(intent, context, selectedObservationIds);
      case "candidate":
        return isCandidateCommandIntent(intent)
          ? await handleCandidateCommand({ api, intent, context, formData, selectedObservationIds })
          : invalidIntentResult(intent, context, selectedObservationIds);
      case "provider-profile":
        return isProviderProfileCommandIntent(intent)
          ? await handleProviderProfileCommand({ api, intent, context, formData, selectedObservationIds })
          : invalidIntentResult(intent, context, selectedObservationIds);
    }
  } catch (error) {
    // Fail closed without leaking the underlying error to the operator banner.
    return {
      feedback: { status: "error", intent, result: commandFailureResult(intent, error) },
      context: { ...context, selectedObservationIds },
      section: context.section,
    };
  }
}

function commandFailureResult(intent: string, error: unknown): CatalogPrimaryWorkbenchCommandFeedback["result"] {
  if (intent === "scope.sync" && isCatalogSyncScopeApiError(error)) {
    return "catalog-sync-blocked";
  }

  return "command-failed";
}

function isCatalogSyncScopeApiError(error: unknown): boolean {
  if (!(error instanceof CatalogApiError) || error.status !== 400) {
    return false;
  }
  const parsed = catalogApiErrorBody(error.body);
  return parsed.code === "invalid_scope";
}

function catalogApiErrorBody(body: unknown): Readonly<{ code: string }> {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("error" in body)) {
    return { code: "unknown" };
  }
  const errorBody = (body as Readonly<{ error?: unknown }>).error;
  if (!errorBody || typeof errorBody !== "object" || Array.isArray(errorBody)) {
    return { code: "unknown" };
  }
  const code = (errorBody as Readonly<Record<string, unknown>>).code;
  return { code: typeof code === "string" && code.trim() ? code.trim() : "unknown" };
}

async function recordCommandTelemetry(
  api: CatalogControlPlaneTelemetryApi,
  result: CatalogIntegrationsCommandResult,
): Promise<void> {
  await recordCatalogControlPlaneEvents(
    api,
    commandTelemetryEvents({
      context: result.context,
      intent: result.feedback.intent,
      status: result.feedback.status,
      result: result.feedback.result,
      commandSection: result.commandSection,
    }),
  );
}
