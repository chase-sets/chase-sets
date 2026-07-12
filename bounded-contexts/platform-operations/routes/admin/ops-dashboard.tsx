import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { OpsDashboardAdminPage } from "../../features/insights-dashboards/ui/ops-dashboard-page";
import type { OpsGranularity } from "../../features/insights-dashboards/api/ops-contracts";
import {
  loadOpsDashboardReconciliationRuns,
  loadOpsDashboardSeries,
  loadOpsDashboardSummary,
} from "../../features/insights-dashboards/api/ops-dashboard-client";

function normalizeRangeDays(value: string | null): string {
  return value === "7" || value === "30" || value === "90" || value === "365" ? value : "30";
}

function normalizeGranularity(value: string | null): OpsGranularity {
  return value === "weekly" || value === "monthly" ? value : "daily";
}

function daysAgoUtc(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const rangeDays = normalizeRangeDays(url.searchParams.get("rangeDays"));
  const granularity = normalizeGranularity(url.searchParams.get("granularity"));
  const to = new Date().toISOString().slice(0, 10);
  const from = daysAgoUtc(Number(rangeDays) - 1);

  const [summary, series, reconciliation] = await Promise.all([
    loadOpsDashboardSummary(request, { from, to }),
    loadOpsDashboardSeries(request, { from, to, granularity }),
    loadOpsDashboardReconciliationRuns(request, { limit: "12" }),
  ]);

  return { summary, series, reconciliationRuns: reconciliation.items, filters: { rangeDays, granularity } };
}

export const meta: MetaFunction = () => [{ title: t("platformOperations.opsDashboard.metaTitle") }];

export default function OpsDashboardRoute() {
  const data = useLoaderData<typeof loader>();
  return (
    <OpsDashboardAdminPage
      summary={data.summary}
      series={data.series}
      reconciliationRuns={data.reconciliationRuns}
      filters={data.filters}
    />
  );
}
