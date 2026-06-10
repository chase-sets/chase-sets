import { t } from "@chase-sets/localization";
import type { ListResponse } from "@chase-sets/http/responses";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useRouteLoaderData } from "react-router";
import { useMemo } from "react";
import type {
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
  SourceObservationListItem,
} from "../../client";
import type { CatalogIntegrationControlPlaneOverview } from "../../features/source-observations/ui/contracts";
import { CatalogPrimaryWorkbenchPage } from "../../features/source-observations/ui/primary-workbench-page";
import {
  buildCatalogPrimaryWorkbenchReadModel,
  buildCatalogPrimaryWorkbenchSourceObservationReviewQuery,
} from "../../features/source-observations/ui/primary-workbench-read-model";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const [routeData, profileReviews, controlPlaneOverview] = await Promise.all([
    loadCatalogListRouteData<SourceObservationIntegrationScope>(request, (query) =>
      api.listSourceObservationIntegrationScopes(query),
    ),
    api.listSourceObservationProviderProfiles<ListResponse<CatalogProviderProfileVersionReview>>(),
    api.getCatalogIntegrationControlPlaneOverview<CatalogIntegrationControlPlaneOverview>(),
  ]);
  const preliminaryReadModel = buildCatalogPrimaryWorkbenchReadModel({
    requestUrl: request.url,
    scopes: routeData.data,
    profileReviews,
    controlPlaneOverview,
    canManageCatalog: true,
  });
  const reviewPagination = { limit: 25, offset: 0 };
  const reviewQuery = buildCatalogPrimaryWorkbenchSourceObservationReviewQuery(
    preliminaryReadModel.routeContext,
    reviewPagination,
  );
  const reviewObservations = reviewQuery
    ? await api.listSourceObservations<ListResponse<SourceObservationListItem>>(reviewQuery)
    : null;
  const readModel = buildCatalogPrimaryWorkbenchReadModel({
    requestUrl: request.url,
    scopes: routeData.data,
    profileReviews,
    controlPlaneOverview,
    reviewObservations,
    reviewPagination,
    canManageCatalog: true,
  });

  return {
    ...routeData,
    profileReviews,
    controlPlaneOverview,
    reviewObservations,
    reviewPagination,
    readModel,
    requestUrl: request.url,
  };
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
  const readModel = useMemo(
    () =>
      canManageCatalog
        ? routeData.readModel
        : buildCatalogPrimaryWorkbenchReadModel({
            requestUrl: routeData.requestUrl,
            scopes: routeData.data,
            profileReviews: routeData.profileReviews,
            controlPlaneOverview: routeData.controlPlaneOverview,
            reviewObservations: routeData.reviewObservations,
            reviewPagination: routeData.reviewPagination,
            canManageCatalog,
          }),
    [canManageCatalog, routeData],
  );

  return <CatalogPrimaryWorkbenchPage readModel={readModel} />;
}
