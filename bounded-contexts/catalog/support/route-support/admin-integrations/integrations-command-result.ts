import type { CatalogIntegrationsCommandResult } from "../../../features/source-observations/ui/contracts";

export type { CatalogIntegrationsCommandResult } from "../../../features/source-observations/ui/contracts";

// The post-command navigation a redirect-owning route performs. The route names
// its own page: `ownerHref` is that page's path with the command's checkpoints.
// This adds the command feedback as query state so the owner's next loader renders
// the same banner; it never derives a destination from the result.
export function commandRedirectHref(ownerHref: string, result: CatalogIntegrationsCommandResult): string {
  const url = new URL(ownerHref, "https://admin.example");
  url.searchParams.set("commandStatus", result.feedback.status);
  url.searchParams.set("commandIntent", result.feedback.intent);
  url.searchParams.set("commandResult", result.feedback.result);
  if (result.feedback.target) {
    url.searchParams.set("commandTargetEntity", result.feedback.target.entity);
    url.searchParams.set("commandTargetCount", String(result.feedback.target.count));
    if (result.feedback.target.id) {
      url.searchParams.set("commandTargetId", result.feedback.target.id);
    }
  }
  if (result.feedback.nextStep) {
    url.searchParams.set("commandNextStep", result.feedback.nextStep);
  }
  if (result.feedback.undoAction) {
    url.searchParams.set("commandUndoAction", result.feedback.undoAction);
  }
  if (result.commandSection) {
    url.searchParams.set("commandSection", result.commandSection);
  }

  return `${url.pathname}${url.search}`;
}

export function commandResultNeedsRoutableHandoff(result: CatalogIntegrationsCommandResult): boolean {
  return (
    (result.feedback.status === "success" &&
      result.feedback.intent === "observation.promote" &&
      result.feedback.result === "job-queued" &&
      Boolean(result.context.jobId)) ||
    (result.feedback.status === "success" &&
      result.feedback.intent === "scope.sync" &&
      result.feedback.result === "job-queued" &&
      Boolean(result.context.jobId))
  );
}
