import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { catalogProviderDetailHref } from "../../../features/source-observations/ui/admin-control-plane/provider-detail/provider-detail-links";
import { dispatchIntegrationsCommand } from "./integrations-command-dispatch";

// Post-command action for the v2 Provider detail page (/catalog/providers/:providerKey).
// Profile clone, section-edit, activate, rollback, deprecate, and retire
// all land back on the one page they were submitted from — never a cross-surface
// detour to the deprecated /catalog/integrations/providers or
// /catalog/integrations/governance surfaces. Command dispatch itself
// (dispatchIntegrationsCommand) is unchanged: it is intent-routed, not
// route-routed, so the same provider-setup/governance command handlers run
// regardless of which route submitted the form.
export async function providerDetailAction(args: ActionFunctionArgs): Promise<Response> {
  const result = await dispatchIntegrationsCommand(args);
  const providerKey = result.context.providerKey ?? routeParamProviderKey(args);

  const href = catalogProviderDetailHref(providerKey, {
    profileVersion: result.context.profileVersion,
    commandStatus: result.feedback.status,
    commandIntent: result.feedback.intent,
    commandResult: result.feedback.result,
    commandSection: result.commandSection,
  });

  return redirect(href);
}

function routeParamProviderKey(args: ActionFunctionArgs): string | null {
  const value = args.params.providerKey;
  return typeof value === "string" && value.trim() ? value : null;
}
