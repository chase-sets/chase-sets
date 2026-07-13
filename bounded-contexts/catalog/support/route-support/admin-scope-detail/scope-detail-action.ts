import type { ActionFunctionArgs } from "react-router";
import { createCatalogRequestApiClient } from "../../request-support/api-client";

// Scope Detail route action (`/catalog/scopes/:id`). Dispatches the
// language-editions section's accept/reject/defer/revoke forms against the
// same Catalog Alias aggregate the generic alias-review table uses (accept,
// reject, revoke via the alias-equivalence HTTP command endpoint; defer keeps
// a candidate pending with no aggregate write) and stays on this page — no
// detour, no `returnPath` — so the operator sees the result in place.
export type ScopeDetailCommandIntent = "accept" | "reject" | "defer" | "revoke";

const SCOPE_DETAIL_COMMAND_INTENTS = new Set<string>(["accept", "reject", "defer", "revoke"]);

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

export async function action({ request }: ActionFunctionArgs): Promise<ScopeDetailCommandResult> {
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "").trim();

  if (!isScopeDetailCommandIntent(intent)) {
    return { status: "error", intent, result: "invalid-intent" };
  }

  const aliasHashes = parseAliasHashes(formData);
  if (aliasHashes.length === 0) {
    return { status: "error", intent, result: "no-candidates" };
  }

  // Deferring keeps a candidate pending; there is no aggregate transition, so
  // the surface just acknowledges and the next loader re-reads the still-pending row.
  if (intent === "defer") {
    return { status: "success", intent, result: "job-queued" };
  }

  const reason = String(formData.get("reason") ?? "").trim();
  if ((intent === "reject" || intent === "revoke") && !reason) {
    return { status: "error", intent, result: "reason-required" };
  }

  const api = createCatalogRequestApiClient(request);
  await api.dispatchCatalogAliasReviewCommand({
    intent,
    aliasHashes,
    ...(reason ? { reason } : {}),
  });

  return { status: "success", intent, result: "job-queued" };
}
