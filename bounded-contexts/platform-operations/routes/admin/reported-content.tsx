import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { ReportedContentAdminListPage } from "../../features/reported-content/ui/admin-pages";
import { createReportedContentRequestApiClient } from "../../support/request-support/reported-content-client";

function filterValue(search: URLSearchParams, key: string) {
  return search.get(key) ?? "all";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createReportedContentRequestApiClient(request);
  const url = new URL(request.url);
  const filters = {
    status: filterValue(url.searchParams, "status"),
    targetType: filterValue(url.searchParams, "targetType"),
  };
  const query = new URLSearchParams({
    limit: "100",
    offset: "0",
  });

  for (const [key, value] of Object.entries(filters)) {
    if (value !== "all") {
      query.set(key, value);
    }
  }

  const [queue, metrics] = await Promise.all([
    api.listReportedContentQueue(query.toString()),
    api.getReportedContentQueueMetrics(),
  ]);

  return { queue, metrics, filters };
}

export const meta: MetaFunction = () => [{ title: t("platformOperations.reportedContent.metaTitle") }];

export default function ReportedContentRoute() {
  const data = useLoaderData<typeof loader>();
  return <ReportedContentAdminListPage queue={data.queue} metrics={data.metrics} filters={data.filters} />;
}
