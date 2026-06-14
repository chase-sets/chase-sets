import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import {
  catalogPrimaryWorkbenchSurfacePathForSection,
  type parseCatalogPrimaryWorkbenchRouteContext,
} from "../../../features/source-observations/ui/primary-workbench-route-context";
import { dispatchIntegrationsCommand } from "./integrations-command-dispatch";
import { commandRedirectHref, type CatalogIntegrationsCommandResult } from "./integrations-command-result";

const DAILY_SURFACE_PATH = catalogPrimaryWorkbenchSurfacePathForSection("import-to-promotion");

// Daily import-to-promotion surface action. The run-sync / preview / create-update
// (promote) and observation-review commands belong to this surface, so a result
// whose canonical surface IS the daily route stays put: the action returns the
// structured result as data and the daily route renders the command-feedback
// banner in place (no redirect hijack). A result that belongs to another surface
// (an operator triggered a profile or lifecycle command from a daily-page control)
// navigates there — the UI makes that call from the returned result, not the
// action's hard-coded routing.
export async function action(args: ActionFunctionArgs): Promise<Response | CatalogIntegrationsCommandResult> {
  const result = await dispatchIntegrationsCommand(args);

  return resultStaysOnDailySurface(result.context, result.section) ? result : redirect(commandRedirectHref(result));
}

function resultStaysOnDailySurface(
  context: ReturnType<typeof parseCatalogPrimaryWorkbenchRouteContext>,
  section: string,
): boolean {
  return catalogPrimaryWorkbenchSurfacePathForSection(section || context.section) === DAILY_SURFACE_PATH;
}
