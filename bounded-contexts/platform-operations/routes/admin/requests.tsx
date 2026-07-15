import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useMatches, useSearchParams } from "react-router";
import { SupportOperationsPage } from "../../features/support-requests/ui/support-operations-page";
import {
  supportOperationsQueueFilters,
  supportOperationsQueuePagination,
  supportOperationsQueueQuery,
} from "../../support/request-support/list-pagination";
import { createSupportRequestRequestApiClient } from "../../support/request-support/support-request-api-client";
import { executeSupportRequestAction } from "../../support/request-support/support-request-action";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("support.routes.admin.operationsQueue.request.failed");
}

export function resolveSupportRequestsMarketplaceOrigin() {
  const configured = process.env.CHASE_SETS_MARKETPLACE_ORIGIN?.trim();
  return configured || null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createSupportRequestRequestApiClient(request);
  const filters = supportOperationsQueueFilters(request);
  const pagination = supportOperationsQueuePagination(request);
  const query = supportOperationsQueueQuery(request);
  const marketplaceOrigin = resolveSupportRequestsMarketplaceOrigin();
  const url = new URL(request.url);
  const selectedRequestId = url.searchParams.get("requestId")?.trim() || null;
  const queueNow = new Date().toISOString();

  const [queueResult, selectedRequestResult] = await Promise.allSettled([
    api.listSupportOperationsQueue(query),
    selectedRequestId ? api.getSupportOperationsRequest(selectedRequestId) : Promise.resolve(null),
  ]);
  const queue = queueResult.status === "fulfilled" ? queueResult.value : { items: [], total: 0, count: 0 };
  const unavailableMessage = queueResult.status === "rejected" ? errorMessage(queueResult.reason) : null;
  const selectedRequest = selectedRequestResult.status === "fulfilled" ? selectedRequestResult.value : null;
  const drawerUnavailableMessage =
    selectedRequestResult.status === "rejected" ? errorMessage(selectedRequestResult.reason) : null;

  return {
    queue,
    filters,
    pagination,
    selectedRequest,
    queueNow,
    unavailableMessage,
    drawerUnavailableMessage,
    marketplaceOrigin,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createSupportRequestRequestApiClient(request);

  if (intent === "escalate-overdue") {
    try {
      const result = await api.escalateOverdueSupportRequests({ limit: 100 });
      const url = new URL(request.url);
      url.searchParams.set("escalated", String(result.escalated));
      url.searchParams.set("skipped", String(result.skipped));
      url.searchParams.set("capped", String(result.capped));
      url.searchParams.set("escalationTotal", String(result.total));
      return redirect(`${url.pathname}${url.search}`);
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  const supportRequestId = String(formData.get("supportRequestId") ?? "").trim();
  if (!supportRequestId) return null;

  try {
    const result = await executeSupportRequestAction(api, supportRequestId, formData);
    if (!result) return null;
    if (result.kind === "preview") {
      return { preview: result.preview, proposalInput: result.proposalInput };
    }

    const url = new URL(request.url);
    url.searchParams.set("requestId", supportRequestId);
    url.searchParams.set("action", result.action);
    url.searchParams.delete("actionError");
    return redirect(`${url.pathname}${url.search}`);
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export const meta: MetaFunction = () => [{ title: t("support.routes.admin.operationsQueue.meta.title") }];

export default function SupportOperationsQueueRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const permissions = useMatches().flatMap((match) => {
    const actor = (match.data as { actor?: { permissions?: readonly string[] } } | undefined)?.actor;
    return actor?.permissions ?? [];
  });
  const escalated = searchParams.get("escalated");
  const skipped = searchParams.get("skipped");
  const capped = searchParams.get("capped");
  const escalationTotal = searchParams.get("escalationTotal");
  const escalationResult =
    escalated !== null && skipped !== null
      ? {
          escalated: Number(escalated),
          skipped: Number(skipped),
          capped: capped === "true",
          total: Number(escalationTotal ?? 0),
        }
      : null;

  return (
    <SupportOperationsPage
      queue={data.queue}
      filters={data.filters}
      pagination={data.pagination}
      selectedRequest={data.selectedRequest}
      queueNow={data.queueNow}
      unavailableMessage={data.unavailableMessage}
      drawerUnavailableMessage={data.drawerUnavailableMessage}
      escalationResult={escalationResult}
      actionError={actionData && "error" in actionData ? (actionData.error ?? null) : searchParams.get("actionError")}
      actionResult={searchParams.get("action")}
      marketplaceOrigin={data.marketplaceOrigin}
      actorPermissions={permissions}
      remedyPreview={actionData && "preview" in actionData ? actionData.preview : null}
      remedyProposalInput={actionData && "proposalInput" in actionData ? actionData.proposalInput : null}
    />
  );
}
