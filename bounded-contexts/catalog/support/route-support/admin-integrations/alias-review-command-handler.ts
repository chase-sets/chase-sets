import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import type { CatalogIntegrationsCommandResult } from "./integrations-command-result";

type Api = ReturnType<typeof createCatalogRequestApiClient>;
type RouteContext = CatalogIntegrationsCommandResult["context"];

// The alias-review workspace POSTs its accept/reject/revoke/defer forms to
// the daily integrations route action. These are the Catalog Alias entity
// actions from the Catalog Control Plane v2 vocabulary
// (`alias.accept` | `alias.reject` | `alias.revoke` | `alias.defer`). They
// drive the Catalog Alias aggregate via the alias-review HTTP command
// endpoint:
//
//   alias.accept → AcceptCatalogAlias (collapses the former accept/auto-accept
//                  split: the aggregate command is identical either way)
//   alias.reject → RejectCatalogAlias (reason required)
//   alias.revoke → RevokeCatalogAlias (reason required)
//   alias.defer  → keeps the candidate pending (no aggregate write)
//
// The daily surface owns these intents, so every result names the
// import-to-promotion section and stays on the daily route with a status banner.
export type AliasReviewCommandIntent = "alias.accept" | "alias.reject" | "alias.revoke" | "alias.defer";

const ALIAS_REVIEW_COMMAND_INTENTS = new Set<string>([
  "alias.accept",
  "alias.reject",
  "alias.revoke",
  "alias.defer",
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
  if (intent === "alias.defer") {
    return aliasResult(intent, "success", "job-queued", context);
  }

  const reason = String(formData.get("reason") ?? "").trim();
  if ((intent === "alias.reject" || intent === "alias.revoke") && !reason) {
    return aliasResult(intent, "error", "reason-required", context);
  }

  await api.dispatchCatalogAliasReviewCommand({
    intent: aliasReviewAggregateIntent(intent),
    aliasHashes,
    ...(reason ? { reason } : {}),
  });

  return aliasResult(intent, "success", "job-queued", context);
}

// The alias-review HTTP command endpoint's own aggregate-command vocabulary
// (accept/reject/revoke) predates this dispatcher's v2 action ids; this is the
// one translation point between the two, so a v2 action id never leaks past it.
function aliasReviewAggregateIntent(
  intent: Exclude<AliasReviewCommandIntent, "alias.defer">,
): "accept" | "reject" | "revoke" {
  switch (intent) {
    case "alias.accept":
      return "accept";
    case "alias.reject":
      return "reject";
    case "alias.revoke":
      return "revoke";
  }
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
