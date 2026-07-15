import type { ActionFunctionArgs } from "react-router";
import { createCatalogRequestApiClient } from "../../request-support/api-client";
import { dispatchIntegrationsCommand } from "../admin-integrations/integrations-command-dispatch";
import type { CatalogIntegrationsCommandResult } from "../admin-integrations/integrations-command-result";

// Scope Detail route action (`/catalog/scopes/:id`). Dispatches the
// language-editions section's alias.accept/alias.reject/alias.defer/alias.revoke
// forms — the Catalog Control Plane v2 entity-scoped action ids — against the
// same Catalog Alias aggregate the generic alias-review table uses (accept,
// reject, revoke via the alias-equivalence HTTP command endpoint; defer keeps
// a candidate pending with no aggregate write) and stays on this page — no
// detour, no `returnPath` — so the operator sees the result in place.
export type ScopeDetailCommandIntent = "alias.accept" | "alias.reject" | "alias.defer" | "alias.revoke";

const SCOPE_DETAIL_COMMAND_INTENTS = new Set<string>([
  "alias.accept",
  "alias.reject",
  "alias.defer",
  "alias.revoke",
] satisfies ScopeDetailCommandIntent[]);

// The alias-review HTTP command endpoint's own aggregate-command vocabulary
// (accept/reject/revoke) predates this action's v2 action ids; this is the one
// translation point between the two, so a v2 action id never leaks past it.
function aliasReviewAggregateIntent(
  intent: Exclude<ScopeDetailCommandIntent, "alias.defer">,
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

export type ScopeDetailCommandResult = Readonly<{
  status: "success" | "error";
  intent: string;
  result: "job-queued" | "reason-required" | "invalid-intent" | "no-candidates" | "command-failed";
}>;

function isScopeDetailCommandIntent(value: string): value is ScopeDetailCommandIntent {
  return SCOPE_DETAIL_COMMAND_INTENTS.has(value);
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

export async function action(
  args: ActionFunctionArgs,
): Promise<ScopeDetailCommandResult | CatalogIntegrationsCommandResult> {
  const { request } = args;
  const formData = await request.clone().formData();
  const intent = String(formData.get("_intent") ?? "").trim();

  if (!isScopeDetailCommandIntent(intent)) {
    return dispatchIntegrationsCommand(args);
  }

  const aliasHashes = parseAliasHashes(formData);
  if (aliasHashes.length === 0) {
    return { status: "error", intent, result: "no-candidates" };
  }

  // Deferring keeps a candidate pending; there is no aggregate transition, so
  // the surface just acknowledges and the next loader re-reads the still-pending row.
  if (intent === "alias.defer") {
    return { status: "success", intent, result: "job-queued" };
  }

  const reason = String(formData.get("reason") ?? "").trim();
  if ((intent === "alias.reject" || intent === "alias.revoke") && !reason) {
    return { status: "error", intent, result: "reason-required" };
  }

  const api = createCatalogRequestApiClient(request);
  await api.dispatchCatalogAliasReviewCommand({
    intent: aliasReviewAggregateIntent(intent),
    aliasHashes,
    ...(reason ? { reason } : {}),
  });

  return { status: "success", intent, result: "job-queued" };
}
