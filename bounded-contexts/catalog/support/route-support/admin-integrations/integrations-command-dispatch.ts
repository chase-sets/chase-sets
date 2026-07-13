import type { ActionFunctionArgs } from "react-router";
import {
  commandTelemetryEvents,
  recordCatalogControlPlaneEvents,
  type CatalogControlPlaneTelemetryApi,
} from "../../../features/source-observations/ui/primary-workbench-telemetry";
import { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import {
  commandContextFromFormData,
  observationIdsFromFormData,
  type CatalogPrimaryWorkbenchFormIntent,
} from "./integrations-command-context";
import { CatalogApiError } from "../../../client";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";
import { handleAliasReviewCommand, isAliasReviewCommandIntent } from "./alias-review-command-handler";
import { handleAttentionQueueCommand, isAttentionQueueCommandIntent } from "./attention-queue-command-handler";
import { handleDailyCommand, isDailyCommandIntent } from "./daily-command-handler";
import { handleGovernanceCommand, isGovernanceCommandIntent } from "./governance-command-handler";
import { handleProviderSetupCommand, isProviderSetupCommandIntent } from "./provider-setup-command-handler";

// The integrations command dispatcher. It routes a submitted intent to the surface
// that owns it (daily / provider-setup / governance), records command telemetry,
// and returns the structured command result as data. It does NOT navigate: the
// surface entry point decides its own post-command UX from the result. No single
// mega-switch owns all 17 intents — each surface handler owns its cohesive group.
export async function dispatchIntegrationsCommand({
  request,
}: ActionFunctionArgs): Promise<CatalogIntegrationsCommandResult> {
  const api = createCatalogRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "") as CatalogPrimaryWorkbenchFormIntent;
  const context = commandContextFromFormData(request.url, formData);
  const selectedObservationIds = observationIdsFromFormData(formData, context.selectedObservationIds);

  const result = await runIntegrationsCommand({ api, intent, context, formData, selectedObservationIds });
  await recordCommandTelemetry(api, result);

  return result;
}

async function runIntegrationsCommand(input: {
  api: ReturnType<typeof createCatalogRequestApiClient>;
  intent: CatalogPrimaryWorkbenchFormIntent;
  context: ReturnType<typeof commandContextFromFormData>;
  formData: FormData;
  selectedObservationIds: readonly string[];
}): Promise<CatalogIntegrationsCommandResult> {
  const { api, intent, context, formData, selectedObservationIds } = input;

  try {
    if (isAliasReviewCommandIntent(intent)) {
      return await handleAliasReviewCommand({ api, intent, context, formData });
    }
    if (isAttentionQueueCommandIntent(intent)) {
      return await handleAttentionQueueCommand({ api, intent, context, formData });
    }
    if (isDailyCommandIntent(intent)) {
      return await handleDailyCommand({ api, intent, context, formData, selectedObservationIds });
    }
    if (isProviderSetupCommandIntent(intent)) {
      return await handleProviderSetupCommand({ api, intent, context, formData, selectedObservationIds });
    }
    if (isGovernanceCommandIntent(intent)) {
      return await handleGovernanceCommand({ api, intent, context, formData, selectedObservationIds });
    }

    return {
      feedback: { status: "error", intent, result: "invalid-intent" },
      context,
      section: context.section,
    };
  } catch (error) {
    // Fail closed without leaking the underlying error to the operator banner.
    return {
      feedback: { status: "error", intent, result: commandFailureResult(intent, error) },
      context: { ...context, selectedObservationIds },
      section: context.section,
    };
  }
}

function commandFailureResult(
  intent: CatalogPrimaryWorkbenchFormIntent,
  error: unknown,
): CatalogPrimaryWorkbenchCommandFeedback["result"] {
  if (intent === "start-catalog-sync" && isCatalogSyncScopeApiError(error)) {
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
