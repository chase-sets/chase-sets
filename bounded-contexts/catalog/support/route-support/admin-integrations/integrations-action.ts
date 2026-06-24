import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import {
  catalogPrimaryWorkbenchSurfacePathForSection,
  type parseCatalogPrimaryWorkbenchRouteContext,
} from "../../../features/source-observations/ui/primary-workbench-route-context";
import { dispatchIntegrationsCommand } from "./integrations-command-dispatch";
import { commandRedirectHref, type CatalogIntegrationsCommandResult } from "./integrations-command-result";

const DAILY_SURFACE_PATH = catalogPrimaryWorkbenchSurfacePathForSection("import-to-promotion");

// Daily import-to-promotion surface action. Most run-sync / create-update
// (promote) and observation-review commands stay on this surface as action data,
// so the daily route renders the command-feedback banner in place. A successful
// promotion preview is the exception: it creates a routable preview checkpoint,
// so it redirects back through the same daily route and lets the loader rebuild
// the create/update stage from the fresh promotionPreviewId. A result that belongs
// to another surface (an operator triggered a profile or lifecycle command from a
// daily-page control) navigates there through the same redirect helper.
export async function action(args: ActionFunctionArgs): Promise<Response | CatalogIntegrationsCommandResult> {
  const result = await dispatchIntegrationsCommand(args);

  if (dailyResultNeedsRoutableHandoff(result)) {
    return redirect(commandRedirectHref(result));
  }

  return resultStaysOnDailySurface(result.context, result.section) ? result : redirect(commandRedirectHref(result));
}

function resultStaysOnDailySurface(
  context: ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>,
  section: string,
): boolean {
  return catalogPrimaryWorkbenchSurfacePathForSection(section || context.section) === DAILY_SURFACE_PATH;
}

function dailyResultNeedsRoutableHandoff(result: CatalogIntegrationsCommandResult): boolean {
  return (
    resultStaysOnDailySurface(result.context, result.section) &&
    result.feedback.status === "success" &&
    result.feedback.intent === "preview-promotion" &&
    result.feedback.result === "preview-ready" &&
    Boolean(result.context.promotionPreviewId)
  );
}
