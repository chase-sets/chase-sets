import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { RiskAlertAdminListPage } from "../../features/risk-alerts/ui/admin-pages";
import { createRiskAlertRequestApiClient } from "../../support/request-support/risk-alert-client";

function filterValue(search: URLSearchParams, key: string) {
  return search.get(key) ?? "all";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createRiskAlertRequestApiClient(request);
  const url = new URL(request.url);
  const filters = {
    status: filterValue(url.searchParams, "status"),
    alertKind: filterValue(url.searchParams, "alertKind"),
  };
  const query = new URLSearchParams({ limit: "100", offset: "0" });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== "all") query.set(key, value);
  }
  const [queue, metrics] = await Promise.all([
    api.listRiskAlertQueue(query.toString()),
    api.getRiskAlertQueueMetrics(),
  ]);
  return { queue, metrics, filters };
}

export const meta: MetaFunction = () => [{ title: t("platformOperations.riskAlerts.metaTitle") }];

export default function RiskAlertsRoute() {
  const data = useLoaderData<typeof loader>();
  return <RiskAlertAdminListPage queue={data.queue} metrics={data.metrics} filters={data.filters} />;
}
