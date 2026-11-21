import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { dispatchIntegrationsCommand } from "../admin-integrations/integrations-command-dispatch";
import {
  commandRedirectHref,
  type CatalogIntegrationsCommandResult,
} from "../admin-integrations/integrations-command-result";
import { scopeDetailCommandHref } from "./scope-detail-route-context";

// Scope Detail owns every command its forms post; its path param names the Scope
// Record. A queued job lands on the Scope's own address with the command's
// checkpoints and feedback, so the job survives reload and the next loader reads
// it. Every other result (a held promotion preview, whose token belongs to the
// POST only, a decision, or a failure) stays on this page as action data.
export async function action(args: ActionFunctionArgs): Promise<Response | CatalogIntegrationsCommandResult> {
  const result = await dispatchIntegrationsCommand(args);
  const scopeRecordId = typeof args.params.id === "string" ? args.params.id.trim() : "";

  return scopeRecordId && commandQueuedJob(result)
    ? redirect(commandRedirectHref(scopeDetailCommandHref(scopeRecordId, result.context), result))
    : result;
}

function commandQueuedJob(result: CatalogIntegrationsCommandResult): boolean {
  return (
    result.feedback.status === "success" && result.feedback.result === "job-queued" && Boolean(result.context.jobId)
  );
}
