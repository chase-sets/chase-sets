import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { catalogPrimaryWorkbenchHref } from "../../../features/source-observations/ui/primary-workbench-route-context";
import { dispatchIntegrationsCommand } from "./integrations-command-dispatch";
import {
  commandRedirectHref,
  commandResultNeedsRoutableHandoff,
  type CatalogIntegrationsCommandResult,
} from "./integrations-command-result";

// Daily import-to-promotion surface action, on its fixed path for as long as the
// surface remains. Every command it receives stays on this surface: most return
// their result as action data, so the daily route retains the original Preview
// and feedback in place. Queued Promote and Catalog sync jobs land on durable
// routable checkpoints; provider imports retain their original enqueue receipt in
// action data.
export async function action(args: ActionFunctionArgs): Promise<Response | CatalogIntegrationsCommandResult> {
  const result = await dispatchIntegrationsCommand(args);

  return commandResultNeedsRoutableHandoff(result) ? redirect(dailyCommandRedirectHref(result)) : result;
}

function dailyCommandRedirectHref(result: CatalogIntegrationsCommandResult): string {
  return commandRedirectHref(catalogPrimaryWorkbenchHref(result.context, "import-to-promotion"), result);
}
