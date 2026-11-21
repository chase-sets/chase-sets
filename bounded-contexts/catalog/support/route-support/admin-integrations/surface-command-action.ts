import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { serializeCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";
import { dispatchIntegrationsCommand } from "./integrations-command-dispatch";
import { commandRedirectHref } from "./integrations-command-result";

// Post-command actions for the Settings, governance and health integrations
// routes. Each route owns its fixed path: a command posted there lands back on
// that same page with its checkpoints and feedback, never on a page derived from
// the result or the submitted URL.
export const settingsCommandAction = surfaceCommandAction("/catalog/integrations/settings");
export const governanceCommandAction = surfaceCommandAction("/catalog/integrations/governance");
export const healthCommandAction = surfaceCommandAction("/catalog/integrations/health");

function surfaceCommandAction(ownerPath: string) {
  return async function action(args: ActionFunctionArgs): Promise<Response> {
    const result = await dispatchIntegrationsCommand(args);
    const query = serializeCatalogPrimaryWorkbenchRouteContext(result.context).toString();

    return redirect(commandRedirectHref(query ? `${ownerPath}?${query}` : ownerPath, result));
  };
}
