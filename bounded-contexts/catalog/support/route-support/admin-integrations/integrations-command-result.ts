import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";
import {
  catalogPrimaryWorkbenchHref,
  type parseCatalogPrimaryWorkbenchRouteContext,
} from "../../../features/source-observations/ui/primary-workbench-route-context";

type RouteContext = ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>;

// The structured outcome every integrations command handler returns. It carries
// the command-feedback banner state and the post-command route context, but it
// does NOT decide navigation: the surface that consumes the result owns its own
// post-command UX. The daily surface stays put and renders the banner; the
// provider detail resolves a redirect from the same result.
export type CatalogIntegrationsCommandResult = Readonly<{
  feedback: CatalogPrimaryWorkbenchCommandFeedback;
  // The route context the surface should reflect after the command. Surfaces that
  // redirect serialize this into the destination href; the daily surface keeps it
  // so the banner and any follow-up command share the fresh context.
  context: RouteContext;
  // The workspace section the result belongs to. Names the canonical surface for a
  // redirect-owning surface; the daily surface ignores it and stays on its route.
  section: string;
  // Optional section scoping for command feedback (profile section saves).
  commandSection?: string;
}>;

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
      result.feedback.result === "preview-ready" &&
      Boolean(result.context.promotionPreviewId)) ||
    (result.feedback.status === "success" &&
      result.feedback.intent === "scope.sync" &&
      result.feedback.result === "job-queued" &&
      Boolean(result.context.jobId))
  );
}
