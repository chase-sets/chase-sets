import { useMemo } from "react";
import { useRouteLoaderData } from "react-router";
import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import { buildCatalogPrimaryWorkbenchReadModel } from "./primary-workbench-read-model";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "./primary-workbench-command-feedback";
import { CatalogIntegrationsSurfacePage } from "./integrations-surface-page";

// The data every integrations surface loader returns (via the shared
// read-model composition). Per-route read-model slicing is #1744; here all four
// surfaces share the same loader-produced read model.
export type CatalogIntegrationsRouteData = Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  commandFeedback?: CatalogPrimaryWorkbenchCommandFeedback | null;
  requestUrl: string;
  data: Parameters<typeof buildCatalogPrimaryWorkbenchReadModel>[0]["scopes"];
  profileReviews: Parameters<typeof buildCatalogPrimaryWorkbenchReadModel>[0]["profileReviews"];
  profileAuthoringModel?: Parameters<typeof buildCatalogPrimaryWorkbenchReadModel>[0]["profileAuthoringModel"];
  lifecycleImpacts?: Parameters<typeof buildCatalogPrimaryWorkbenchReadModel>[0]["lifecycleImpacts"];
  controlPlaneOverview: Parameters<typeof buildCatalogPrimaryWorkbenchReadModel>[0]["controlPlaneOverview"];
  reviewObservations?: Parameters<typeof buildCatalogPrimaryWorkbenchReadModel>[0]["reviewObservations"];
  reviewPagination?: Parameters<typeof buildCatalogPrimaryWorkbenchReadModel>[0]["reviewPagination"];
}>;

type CatalogLayoutRouteData = Readonly<{
  actor?: Readonly<{ permissions?: readonly string[] }> | null;
}>;

// Shared thin view for the four integrations surface routes. It re-derives the
// read model when the operator lacks catalog.manage (same fallback as the legacy
// single page) and composes the surface page for the given audience surface.
export function CatalogIntegrationsSurfaceRouteView({
  surface,
  routeData,
}: Readonly<{
  surface: CatalogControlPlaneRouteSurfaceKey;
  routeData: CatalogIntegrationsRouteData;
}>) {
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
            profileAuthoringModel: routeData.profileAuthoringModel,
            lifecycleImpacts: routeData.lifecycleImpacts,
            controlPlaneOverview: routeData.controlPlaneOverview,
            reviewObservations: routeData.reviewObservations,
            reviewPagination: routeData.reviewPagination,
            canManageCatalog,
          }),
    [canManageCatalog, routeData],
  );

  return (
    <CatalogIntegrationsSurfacePage
      surface={surface}
      readModel={readModel}
      commandFeedback={routeData.commandFeedback}
    />
  );
}
