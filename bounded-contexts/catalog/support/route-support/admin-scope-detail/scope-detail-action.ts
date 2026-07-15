import type { ActionFunctionArgs } from "react-router";
import { dispatchIntegrationsCommand } from "../admin-integrations/integrations-command-dispatch";

// Scope detail uses the same command dispatcher as every other Catalog control
// plane route, preserving the uniform feedback envelope for banners and
// routable promotion or sync handoffs.
export async function action(args: ActionFunctionArgs) {
  return dispatchIntegrationsCommand(args);
}
