import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";

// Parse the post-command redirect query (?commandStatus/&commandResult/&commandIntent)
// into the typed feedback banner state. Shared by every integrations surface
// loader so each route surfaces the same command outcome banner.
export function commandFeedbackFromUrl(url: string | URL): CatalogPrimaryWorkbenchCommandFeedback | null {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  const status = parsedUrl.searchParams.get("commandStatus");
  const result = parsedUrl.searchParams.get("commandResult");
  const intent = parsedUrl.searchParams.get("commandIntent") ?? "unknown";

  if ((status !== "success" && status !== "error") || !isCommandFeedbackResult(result)) {
    return null;
  }

  return { status, intent, result };
}

function isCommandFeedbackResult(value: string | null): value is CatalogPrimaryWorkbenchCommandFeedback["result"] {
  return (
    value === "job-queued" ||
    value === "job-cancelled" ||
    value === "preview-ready" ||
    value === "draft-created" ||
    value === "profile-activated" ||
    value === "profile-rolled-back" ||
    value === "profile-deprecated" ||
    value === "profile-retired" ||
    value === "section-saved" ||
    value === "section-conflict" ||
    value === "section-invalid" ||
    value === "lifecycle-conflict" ||
    value === "confirmation-required" ||
    value === "preview-required" ||
    value === "job-required" ||
    value === "reason-required" ||
    value === "catalog-sync-blocked" ||
    value === "unsupported-command" ||
    value === "invalid-intent" ||
    value === "command-failed"
  );
}
