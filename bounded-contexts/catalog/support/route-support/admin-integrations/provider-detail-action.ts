import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { catalogProviderDetailHref } from "../../../features/source-observations/ui/admin-control-plane/provider-detail/provider-detail-links";
import { createCatalogRequestApiClient } from "../../request-support/api-client";
import { dispatchIntegrationsCommand } from "./integrations-command-dispatch";

const PROVIDER_REFRESH_INTENTS = new Set(["pause-provider-refresh", "resume-provider-refresh", "run-provider-refresh"]);

export async function providerDetailAction(args: ActionFunctionArgs): Promise<Response> {
  const formData = await args.request.clone().formData();
  const intent = String(formData.get("_intent") ?? "");
  if (PROVIDER_REFRESH_INTENTS.has(intent)) {
    return handleProviderRefreshCommand(args, intent);
  }

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

async function handleProviderRefreshCommand(args: ActionFunctionArgs, intent: string): Promise<Response> {
  const requestUrl = new URL(args.request.url);
  const providerKey = routeParamProviderKey(args);
  if (providerKey) {
    const api = createCatalogRequestApiClient(args.request);
    if (intent === "run-provider-refresh") {
      await api.runCatalogProviderRefreshNow(providerKey).catch(() => null);
    } else {
      await api
        .setCatalogProviderRefreshPaused({ providerKey, paused: intent === "pause-provider-refresh" })
        .catch(() => null);
    }
  }

  return redirect(
    catalogProviderDetailHref(providerKey, {
      profileVersion: requestUrl.searchParams.get("profileVersion"),
    }),
  );
}

function routeParamProviderKey(args: ActionFunctionArgs): string | null {
  const value = args.params.providerKey;
  return typeof value === "string" && value.trim() ? value : null;
}
