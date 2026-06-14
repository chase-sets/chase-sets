import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { dispatchIntegrationsCommand } from "./integrations-command-dispatch";
import { commandRedirectHref } from "./integrations-command-result";

// Post-command action for the redirect-owning integrations surfaces (provider
// setup, governance, release). These surfaces commit profile-lifecycle and
// authoring operations that belong to a specific governance/authoring section, so
// the surface navigates to that section after the command — carrying the command
// feedback as query state so the destination renders the same banner. The
// navigation is the surface's decision, derived from the structured result rather
// than hard-coded inside the command logic.
export async function surfaceCommandAction(args: ActionFunctionArgs): Promise<Response> {
  const result = await dispatchIntegrationsCommand(args);

  return redirect(commandRedirectHref(result));
}
