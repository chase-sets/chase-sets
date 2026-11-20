import type { CatalogIntegrationsCommandResult } from "../../../features/source-observations/ui/contracts";
import { catalogPrimaryWorkbenchHref } from "../../../features/source-observations/ui/primary-workbench-route-context";

export type { CatalogIntegrationsCommandResult } from "../../../features/source-observations/ui/contracts";

// The post-command navigation a redirect-owning surface performs. The UI decides
// this from the result rather than hard-coding it in the action. The href routes
// to the canonical surface for the result's section and carries the command
// feedback as query state so the destination loader can render the same banner.
export function commandRedirectHref(result: CatalogIntegrationsCommandResult): string {
  const url = new URL(catalogPrimaryWorkbenchHref(result.context, result.section), "https://admin.example");
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
