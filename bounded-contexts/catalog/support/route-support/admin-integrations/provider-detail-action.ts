import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { catalogProviderDetailHref } from "../../../features/source-observations/ui/admin-control-plane/provider-detail/provider-detail-links";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";
import { createCatalogRequestApiClient } from "../../request-support/api-client";
import { ApiError as CatalogApiError } from "../../shell-support/api/client";
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
    unitKey: result.context.unitKey,
    jobId: result.context.jobId,
    commandStatus: result.feedback.status,
    commandIntent: result.feedback.intent,
    commandResult: result.feedback.result,
    commandSection: result.commandSection,
  });

  return redirect(href);
}

type RefreshFeedback = Pick<CatalogPrimaryWorkbenchCommandFeedback, "status" | "result">;

async function handleProviderRefreshCommand(args: ActionFunctionArgs, intent: string): Promise<Response> {
  const requestUrl = new URL(args.request.url);
  const providerKey = routeParamProviderKey(args);
  const feedback = providerKey ? await runProviderRefreshCommand(args.request, providerKey, intent) : null;

  return redirect(
    catalogProviderDetailHref(providerKey, {
      profileVersion: requestUrl.searchParams.get("profileVersion"),
      commandStatus: feedback?.status,
      commandIntent: feedback ? intent : null,
      commandResult: feedback?.result,
    }),
  );
}

async function runProviderRefreshCommand(
  request: Request,
  providerKey: string,
  intent: string,
): Promise<RefreshFeedback> {
  const api = createCatalogRequestApiClient(request);
  try {
    if (intent === "run-provider-refresh") {
      const run = await api.runCatalogProviderRefreshNow<{ status?: string }>(providerKey);
      return { status: "success", result: run?.status === "skipped-no-targets" ? "refresh-skipped" : "refresh-ran" };
    }
    const paused = intent === "pause-provider-refresh";
    await api.setCatalogProviderRefreshPaused({ providerKey, paused });
    return { status: "success", result: paused ? "refresh-paused" : "refresh-resumed" };
  } catch (error) {
    if (!(error instanceof CatalogApiError)) throw error;
    // The API answers a run whose pull failed with 502 and the run's own status.
    const runFailed = error.status === 502 && (error.body as { status?: unknown } | null)?.status === "failed";
    return { status: "error", result: runFailed ? "refresh-run-failed" : "command-failed" };
  }
}

function routeParamProviderKey(args: ActionFunctionArgs): string | null {
  const value = args.params.providerKey;
  return typeof value === "string" && value.trim() ? value : null;
}
