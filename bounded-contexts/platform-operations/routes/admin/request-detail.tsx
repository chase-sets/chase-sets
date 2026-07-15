import { t } from "@chase-sets/localization";
import { defineFormAction, type FormActionContext } from "@chase-sets/platform-runtime/http";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";
import { executeSupportRequestAction } from "../../support/request-support/support-request-action";
import { createSupportRequestRequestApiClient } from "../../support/request-support/support-request-api-client";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("support.routes.admin.operationsRequestDetail.request.failed");
}

function queueReturnLocation(request: Request, supportRequestId: string, action?: string, actionError?: string) {
  const requestUrl = new URL(request.url);
  const configuredReturnTo = requestUrl.searchParams.get("returnTo");
  if (!configuredReturnTo && action) {
    return `/support/requests/${supportRequestId}?action=${encodeURIComponent(action)}`;
  }

  const target = configuredReturnTo
    ? new URL(configuredReturnTo, requestUrl.origin)
    : new URL("/support/requests", requestUrl);
  const isQueueTarget = target.origin === requestUrl.origin && target.pathname === "/support/requests";
  const safeTarget = isQueueTarget ? target : new URL("/support/requests", requestUrl);
  safeTarget.searchParams.set("requestId", supportRequestId);
  if (action) safeTarget.searchParams.set("action", action);
  else safeTarget.searchParams.delete("action");
  if (actionError) safeTarget.searchParams.set("actionError", actionError);
  else safeTarget.searchParams.delete("actionError");
  return `${safeTarget.pathname}${safeTarget.search}`;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const action = new URL(request.url).searchParams.get("action") ?? undefined;
  return redirect(queueReturnLocation(request, params.id ?? "", action));
}

async function handleAction({ request, params, formData }: FormActionContext) {
  const supportRequestId = params.id ?? "";

  try {
    const result = await executeSupportRequestAction(
      createSupportRequestRequestApiClient(request),
      supportRequestId,
      formData,
    );
    if (!result) return null;
    if (result.kind === "preview") {
      return { preview: result.preview, proposalInput: result.proposalInput };
    }
    return redirect(queueReturnLocation(request, supportRequestId, result.action));
  } catch (error) {
    const message = errorMessage(error);
    if (new URL(request.url).searchParams.has("returnTo")) {
      return redirect(
        queueReturnLocation(
          request,
          supportRequestId,
          undefined,
          t("support.routes.admin.operationsRequestDetail.request.failed"),
        ),
      );
    }
    return { error: message };
  }
}

export const action = defineFormAction({
  intents: {
    note: handleAction,
    response: handleAction,
    escalate: handleAction,
    resolve: handleAction,
    close: handleAction,
    cancel: handleAction,
    "preview-remedy": handleAction,
    "propose-remedy": handleAction,
    "approve-remedy": handleAction,
    "retry-remedy-effect": handleAction,
    "waive-remedy-effect": handleAction,
    "release-remedy-refund": handleAction,
    "request-remedy-correction": handleAction,
  },
  onUnknownIntent: handleAction,
});

export const meta: MetaFunction = () => [{ title: t("support.routes.admin.operationsQueue.meta.title") }];

export default function SupportOperationsRequestDetailRoute() {
  return null;
}
