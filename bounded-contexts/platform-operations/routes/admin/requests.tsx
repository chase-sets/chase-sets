import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import { SupportOperationsPage } from "../../features/support-requests/ui/support-operations-page";
import {
  supportOperationsQueueFilters,
  supportOperationsQueuePagination,
  supportOperationsQueueQuery,
} from "../../support/request-support/list-pagination";
import { createSupportRequestRequestApiClient } from "../../support/request-support/support-request-api-client";

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

  try {
    return {
      queue: await api.listSupportOperationsQueue(query),
      filters,
      pagination,
      unavailableMessage: null,
      marketplaceOrigin,
    };
  } catch (error) {
    return {
      queue: {
        items: [],
        total: 0,
        count: 0,
      },
      filters,
      pagination,
      unavailableMessage: errorMessage(error),
      marketplaceOrigin,
    };
  }
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

  return null;
}

export const meta: MetaFunction = () => [{ title: t("support.routes.admin.operationsQueue.meta.title") }];

export default function SupportOperationsQueueRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
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
      unavailableMessage={data.unavailableMessage}
      escalationResult={escalationResult}
      actionError={actionData?.error ?? null}
      marketplaceOrigin={data.marketplaceOrigin}
    />
  );
}
