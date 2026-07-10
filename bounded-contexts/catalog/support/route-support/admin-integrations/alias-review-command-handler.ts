import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";

type Api = ReturnType<typeof createCatalogRequestApiClient>;
type RouteContext = CatalogIntegrationsCommandResult["context"];

// The alias-review workspace POSTs its accept/reject/revoke/defer forms to
// the daily integrations route action. These intents drive the Catalog
// Alias aggregate via the alias-review HTTP command endpoint:
//
//   accept / auto-accept → AcceptCatalogAlias
//   reject               → RejectCatalogAlias (reason required)
//   revoke               → RevokeCatalogAlias (reason required)
//   defer                → keeps the candidate pending (no aggregate write)
//
// The daily surface owns these intents, so every result names the
// import-to-promotion section and stays on the daily route with a status banner.
export type AliasReviewCommandIntent = "accept" | "auto-accept" | "reject" | "revoke" | "defer";

const ALIAS_REVIEW_COMMAND_INTENTS = new Set<string>([
  "accept",
  "auto-accept",
  "reject",
  "revoke",
  "defer",
] satisfies AliasReviewCommandIntent[]);

export function isAliasReviewCommandIntent(intent: string): intent is AliasReviewCommandIntent {
  return ALIAS_REVIEW_COMMAND_INTENTS.has(intent);
}

function parseAliasHashes(formData: FormData): readonly string[] {
  return [
    ...new Set(
      String(formData.get("aliasHashes") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export async function handleAliasReviewCommand(input: {
  api: Api;
  intent: AliasReviewCommandIntent;
  context: RouteContext;
  formData: FormData;
}): Promise<CatalogIntegrationsCommandResult> {
  const { api, intent, context, formData } = input;
  const aliasHashes = parseAliasHashes(formData);

  if (aliasHashes.length === 0) {
    return aliasResult(intent, "error", "command-failed", context);
  }

  // Deferring keeps a candidate pending; there is no aggregate transition, so the
  // surface just acknowledges and the next loader re-reads the still-pending row.
  if (intent === "defer") {
    return aliasResult(`alias-${intent}`, "success", "job-queued", context);
  }

  const reason = String(formData.get("reason") ?? "").trim();
  if ((intent === "reject" || intent === "revoke") && !reason) {
    return aliasResult(`alias-${intent}`, "error", "reason-required", context);
  }

  await api.dispatchCatalogAliasReviewCommand({
    intent: intent === "auto-accept" ? "accept" : intent,
    aliasHashes,
    ...(reason ? { reason } : {}),
  });

  return aliasResult(`alias-${intent}`, "success", "job-queued", context);
}

function aliasResult(
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
