import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { WaitlistAdminPage } from "../../features/waitlist/ui/admin-pages";
import { createPublicPresenceRequestApiClient } from "../../support/request-support/api-client";

function filterValue(search: URLSearchParams, key: string) {
  if (key === "search") {
    return search.get(key) ?? "";
  }
  if (key === "sort") {
    return search.get(key) ?? "updated";
  }
  return search.get(key) ?? "all";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createPublicPresenceRequestApiClient(request);
  const url = new URL(request.url);
  const filters = {
    role: filterValue(url.searchParams, "role"),
    interest: filterValue(url.searchParams, "interest"),
    search: filterValue(url.searchParams, "search"),
    sort: filterValue(url.searchParams, "sort"),
  };
  const query = new URLSearchParams({
    limit: "100",
    offset: "0",
  });

  const filterDefaults: Record<string, string> = { role: "all", interest: "all", search: "", sort: "updated" };
  for (const [key, value] of Object.entries(filters)) {
    if (value && value !== filterDefaults[key]) {
      query.set(key, value);
    }
  }

  const [signups, metrics] = await Promise.all([api.listWaitlistSignups(query.toString()), api.getWaitlistMetrics()]);

  return {
    signups,
    metrics,
    filters,
    exportHref: `/api/public-presence/admin/waitlist/export?${query.toString()}`,
  };
}

export const meta: MetaFunction = () => [{ title: t("publicPresence.routes.admin.waitlist.meta.title") }];

export default function WaitlistAdminRoute() {
  const data = useLoaderData<typeof loader>();
  return (
    <WaitlistAdminPage
      signups={data.signups}
      metrics={data.metrics}
      filters={data.filters}
      exportHref={data.exportHref}
    />
  );
}
