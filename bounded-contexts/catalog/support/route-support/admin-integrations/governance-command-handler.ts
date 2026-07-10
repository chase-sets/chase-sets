import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";
import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import {
  lifecycleConfirmationAccepted,
  lifecycleFailureResult,
  lifecycleSuccessResult,
  runProviderProfileLifecycleCommand,
} from "./integrations-command-context";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";
import { stringValue } from "./integrations-form-values";

type Api = ReturnType<typeof createCatalogRequestApiClient>;
type RouteContext = CatalogIntegrationsCommandResult["context"];

// The govern-and-recover surface owns the destructive provider profile lifecycle
// operations (rollback, deprecate, retire). These genuinely belong on another
// surface, so their results name the lifecycle-recovery section: the surface
// resolves a redirect from the result; the action itself never forces one.
export type GovernanceCommandIntent =
  | "rollback-provider-profile"
  | "deprecate-provider-profile"
  | "retire-provider-profile";

const GOVERNANCE_COMMAND_INTENTS = new Set<string>([
  "rollback-provider-profile",
  "deprecate-provider-profile",
  "retire-provider-profile",
] satisfies GovernanceCommandIntent[]);

export function isGovernanceCommandIntent(intent: string): intent is GovernanceCommandIntent {
  return GOVERNANCE_COMMAND_INTENTS.has(intent);
}

export async function handleGovernanceCommand(input: {
  api: Api;
  intent: GovernanceCommandIntent;
  context: RouteContext;
  formData: FormData;
  selectedObservationIds: readonly string[];
}): Promise<CatalogIntegrationsCommandResult> {
  const { api, intent, context, formData, selectedObservationIds } = input;
  const providerKey = stringValue(formData.get("providerKey")) ?? context.providerKey;
  const profileVersion = stringValue(formData.get("profileVersion")) ?? context.profileVersion;

  if (!providerKey || !profileVersion) {
    return lifecycleResult(intent, "error", "invalid-intent", {
      ...context,
      section: "lifecycle-recovery",
      selectedObservationIds,
    });
  }
  if (!lifecycleConfirmationAccepted(formData, intent, providerKey, profileVersion)) {
    return lifecycleResult(intent, "error", "confirmation-required", {
      ...context,
      section: "lifecycle-recovery",
      providerKey,
      profileVersion,
      selectedObservationIds,
      promotionPreviewId: null,
    });
  }

  try {
    const profile = await runProviderProfileLifecycleCommand(api, intent, providerKey, profileVersion);

    return lifecycleResult(intent, "success", lifecycleSuccessResult(intent), {
      ...context,
      section: "lifecycle-recovery",
      providerKey: profile.providerKey,
      profileVersion: profile.profileVersion,
      selectedObservationIds,
      promotionPreviewId: null,
    });
  } catch (error) {
    return lifecycleResult(intent, "error", lifecycleFailureResult(error), {
      ...context,
      section: "lifecycle-recovery",
      providerKey,
      profileVersion,
      selectedObservationIds,
      promotionPreviewId: null,
    });
  }
}

function lifecycleResult(
  intent: GovernanceCommandIntent,
  status: CatalogPrimaryWorkbenchCommandFeedback["status"],
  result: CatalogPrimaryWorkbenchCommandFeedback["result"],
  context: RouteContext,
): CatalogIntegrationsCommandResult {
  return {
    feedback: { status, intent, result },
    context,
    section: "lifecycle-recovery",
  };
}
