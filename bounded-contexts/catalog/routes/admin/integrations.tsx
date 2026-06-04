import { t } from "@chase-sets/localization";
import type { ListResponse } from "@chase-sets/http/responses";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useRouteLoaderData } from "react-router";
import type { CatalogProviderProfileVersionReview, SourceObservationIntegrationScope } from "../../client";
import { IntegrationManagementPage } from "../../features/source-observations/ui/integration-management-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const routeData = await loadCatalogListRouteData<SourceObservationIntegrationScope>(request, (query) =>
    api.listSourceObservationIntegrationScopes(query),
  );
  const profileReviews =
    await api.listSourceObservationProviderProfiles<ListResponse<CatalogProviderProfileVersionReview>>();
  return { ...routeData, profileReviews };
}

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.integrations.catalog.integrations.catalog.admin") },
];

type CatalogLayoutRouteData = Readonly<{
  actor?: Readonly<{ permissions?: readonly string[] }> | null;
}>;

export default function IntegrationsRoute() {
  const routeData = useLoaderData<typeof loader>();
  const catalogLayoutData = useRouteLoaderData("routes/catalog-layout") as CatalogLayoutRouteData | undefined;
  const canManageCatalog = catalogLayoutData?.actor?.permissions?.includes("catalog.manage") ?? true;

  return (
    <IntegrationManagementPage
      data={routeData.data}
      query={routeData.query}
      profileReviews={routeData.profileReviews}
      permissions={{ canManageCatalog }}
    />
  );
}
