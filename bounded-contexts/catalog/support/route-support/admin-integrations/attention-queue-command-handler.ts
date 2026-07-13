import {
  CATALOG_ATTENTION_DEFER_INTENT,
  CATALOG_ATTENTION_DISMISS_INTENT,
  CATALOG_ATTENTION_RESTORE_INTENT,
  isCatalogAttentionCommandIntent,
  type CatalogAttentionCommandIntent,
} from "../../../features/attention-queue/read-model/attention-intents";
import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";

type Api = ReturnType<typeof createCatalogRequestApiClient>;
type RouteContext = CatalogIntegrationsCommandResult["context"];

// The attention-queue panel POSTs its park (dismiss / defer) and restore forms to
// the daily integrations route action. Each intent drives the attention-dismissal
// aggregate over the attention-queue HTTP command endpoint. The daily surface owns
// these intents, so every result names the import-to-promotion section and stays
// on the daily route with a status banner — acting on a queue item never navigates
// to a different surface (AC: zero returnPath-style detours).
export { isCatalogAttentionCommandIntent as isAttentionQueueCommandIntent };

const HTTP_INTENT: Readonly<Record<CatalogAttentionCommandIntent, "dismiss" | "defer" | "restore">> = {
  [CATALOG_ATTENTION_DISMISS_INTENT]: "dismiss",
  [CATALOG_ATTENTION_DEFER_INTENT]: "defer",
  [CATALOG_ATTENTION_RESTORE_INTENT]: "restore",
};

export async function handleAttentionQueueCommand(input: {
  api: Api;
  intent: string;
  context: RouteContext;
  formData: FormData;
}): Promise<CatalogIntegrationsCommandResult> {
  const { api, intent, context, formData } = input;
  if (!isCatalogAttentionCommandIntent(intent)) {
    return attentionResult(intent, "error", "invalid-intent", context);
  }

  const itemKey = String(formData.get("itemKey") ?? "").trim();
  if (!itemKey) {
    return attentionResult(intent, "error", "command-failed", context);
  }

  const httpIntent = HTTP_INTENT[intent];

  if (httpIntent === "restore") {
    await api.dispatchCatalogAttentionQueueCommand({ intent: "restore", itemKey });
    return attentionResult(intent, "success", "job-queued", context);
  }

  const kind = String(formData.get("kind") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) {
    return attentionResult(intent, "error", "reason-required", context);
  }

  if (httpIntent === "dismiss") {
    await api.dispatchCatalogAttentionQueueCommand({ intent: "dismiss", itemKey, kind, reason });
    return attentionResult(intent, "success", "job-queued", context);
  }

  const deferHours = Number(formData.get("deferHours") ?? "24");
  await api.dispatchCatalogAttentionQueueCommand({
    intent: "defer",
    itemKey,
    kind,
    reason,
    deferHours: Number.isFinite(deferHours) && deferHours > 0 ? deferHours : 24,
  });
  return attentionResult(intent, "success", "job-queued", context);
}

function attentionResult(
  intent: string,
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
