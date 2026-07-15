import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";
import { createSupportRequestRequestApiClient } from "../../support/request-support/support-request-api-client";
import { executeSupportRequestAction } from "../../support/request-support/support-request-action";

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

export async function action({ request, params }: ActionFunctionArgs) {
  const supportRequestId = params.id ?? "";
  const api = createSupportRequestRequestApiClient(request);
  const formData = await request.formData();

  try {
    const result = await executeSupportRequestAction(api, supportRequestId, formData);
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

export const meta: MetaFunction = () => [{ title: t("support.routes.admin.operationsQueue.meta.title") }];

export default function SupportOperationsRequestDetailRoute() {
  return null;
}
