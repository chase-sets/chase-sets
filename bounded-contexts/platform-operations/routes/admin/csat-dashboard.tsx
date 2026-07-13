import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { CsatAdminPage } from "../../features/csat-dashboard/ui/admin-page";
import { createExperienceRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createExperienceRequestApiClient(request);
  const url = new URL(request.url);
  return api.getCsatDashboard(url.searchParams.toString());
}

export const meta: MetaFunction = () => [{ title: t("experience.csatAdmin.title") }];

export default function CsatDashboardRoute() {
  return <CsatAdminPage data={useLoaderData<typeof loader>()} />;
}
