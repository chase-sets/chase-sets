import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { createCatalogRequestApiClient } from "../../request-support/api-client";
import { surfaceCommandAction } from "./surface-command-action";

const PROVIDER_REFRESH_INTENTS = new Set(["pause-provider-refresh", "resume-provider-refresh", "run-provider-refresh"]);

// Action for the providers surface (/admin/integrations/providers). The
// scheduled source-option refresh controls are a self-contained panel
// outside the workbench command dispatcher, so this action handles their three
// intents directly and delegates everything else to the shared integrations
// surface command action. The request is cloned before reading form data so the
// delegated action can still consume the original body.
export async function providersSurfaceCommandAction(args: ActionFunctionArgs): Promise<Response> {
  const formData = await args.request.clone().formData();
  const intent = String(formData.get("_intent") ?? "");
  if (!PROVIDER_REFRESH_INTENTS.has(intent)) {
    return surfaceCommandAction(args);
  }

  const providerKey = String(formData.get("providerKey") ?? "").trim();
  const api = createCatalogRequestApiClient(args.request);
  if (providerKey) {
    if (intent === "run-provider-refresh") {
      await api.runCatalogProviderRefreshNow(providerKey).catch(() => null);
    } else {
      await api
        .setCatalogProviderRefreshPaused({ providerKey, paused: intent === "pause-provider-refresh" })
        .catch(() => null);
    }
  }

  // Reload the surface the form posted to so the panel re-renders the
  // authoritative schedule state (including a failed command's unchanged row).
  const requestUrl = new URL(args.request.url);
  return redirect(`${requestUrl.pathname}${requestUrl.search}`);
}
