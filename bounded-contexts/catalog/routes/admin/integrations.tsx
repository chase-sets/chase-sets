import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useLoaderData, useRouteLoaderData } from "react-router";
import { useMemo } from "react";
import { CatalogPrimaryWorkbenchPage } from "../../features/source-observations/ui/primary-workbench-page";
import { buildCatalogPrimaryWorkbenchReadModel } from "../../features/source-observations/ui/primary-workbench-read-model";
import { loader } from "../../support/shell-support/admin-integrations/integrations-loader";

export { action } from "../../support/shell-support/admin-integrations/integrations-action";
export { loader } from "../../support/shell-support/admin-integrations/integrations-loader";

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
            profileAuthoringModel: routeData.profileAuthoringModel,
            lifecycleImpacts: routeData.lifecycleImpacts,
            controlPlaneOverview: routeData.controlPlaneOverview,
            reviewObservations: routeData.reviewObservations,
            reviewPagination: routeData.reviewPagination,
            canManageCatalog,
          }),
    [canManageCatalog, routeData],
  );

  return <CatalogPrimaryWorkbenchPage readModel={readModel} commandFeedback={routeData.commandFeedback} />;
}
