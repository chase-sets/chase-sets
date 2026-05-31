import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { t } from "@chase-sets/localization";
import { loadReleaseDashboardSnapshot } from "../../features/release-dashboard/api/client";
import { ReleaseDashboardPage } from "../../features/release-dashboard/ui/release-dashboard-page";

const routeKey = "platformOperations.releaseDashboard";

export const meta: MetaFunction = () => [{ title: t(`${routeKey}.metaTitle`) }];

export async function loader(_args: LoaderFunctionArgs) {
  return {
    data: await loadReleaseDashboardSnapshot(),
  };
}

export default function ReleaseDashboardRoute() {
  const { data } = useLoaderData<typeof loader>();
  return <ReleaseDashboardPage data={data} />;
}
