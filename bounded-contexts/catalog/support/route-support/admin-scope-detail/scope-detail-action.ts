import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { catalogScopeDetailCommandSubmission } from "../../../features/source-observations/api/admin/scope-detail-workbench-location";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";
import { createCatalogRequestApiClient, type CatalogScopeRecordDetail } from "../../request-support/api-client";
import { dispatchIntegrationsCommand } from "../admin-integrations/integrations-command-dispatch";
import {
  commandRedirectHref,
  type CatalogIntegrationsCommandResult,
} from "../admin-integrations/integrations-command-result";
import { scopeDetailCommandHref } from "./scope-detail-route-context";

// Scope Detail owns every command its forms post; its path param names the Scope
// Record, whose hierarchy the command is bound to before it is dispatched. A
// queued job lands on the Scope's own address with the command's checkpoints and
// feedback, so the job survives reload and the next loader reads it. Every other
// result (a held promotion preview, whose token belongs to the POST only, a
// decision, a refusal or a failure) stays on this page as action data.
export async function action(args: ActionFunctionArgs): Promise<Response | CatalogIntegrationsCommandResult> {
  const scopeRecordId = typeof args.params.id === "string" ? args.params.id.trim() : "";
  const command = await scopeBoundCommand(args.request, scopeRecordId);
  if (!(command instanceof Request)) {
    return command;
  }
  const result = await dispatchIntegrationsCommand({ ...args, request: command });

  return commandQueuedJob(result)
    ? redirect(commandRedirectHref(scopeDetailCommandHref(scopeRecordId, result.context), result))
    : result;
}

// The command as the Scope Record decides it: the record's hierarchy and id
// replace the submitted ones. A form or address that names another hierarchy
// value or Scope Record, or a record that cannot be read, is refused here rather
// than dispatched against another Scope.
async function scopeBoundCommand(
  request: Request,
  scopeRecordId: string,
): Promise<Request | CatalogIntegrationsCommandResult> {
  const formData = await request.formData();
  const scope = scopeRecordId ? await readScopeRecord(request, scopeRecordId) : null;
  const submission = scope ? catalogScopeDetailCommandSubmission(new URL(request.url), formData, scope) : null;
  if (!submission) {
    return refusedCommand(formData, request.url);
  }

  const headers = new Headers(request.headers);
  headers.delete("content-type");
  headers.delete("content-length");
  return new Request(submission.location, {
    method: request.method,
    headers,
    body: submission.formData,
    signal: request.signal,
  });
}

async function readScopeRecord(request: Request, scopeRecordId: string): Promise<CatalogScopeRecordDetail | null> {
  try {
    return await createCatalogRequestApiClient(request).getCatalogScopeRecord<CatalogScopeRecordDetail>(scopeRecordId);
  } catch {
    return null;
  }
}

function refusedCommand(formData: FormData, requestUrl: string): CatalogIntegrationsCommandResult {
  return {
    feedback: {
      status: "error",
      intent: String(formData.get("_intent") ?? ""),
      result: "invalid-intent",
      nextStep: "correct-input",
    },
    context: { ...parseCatalogPrimaryWorkbenchRouteContext(requestUrl), promotionPreviewId: null },
  };
}

function commandQueuedJob(result: CatalogIntegrationsCommandResult): boolean {
  return (
    result.feedback.status === "success" && result.feedback.result === "job-queued" && Boolean(result.context.jobId)
  );
}
