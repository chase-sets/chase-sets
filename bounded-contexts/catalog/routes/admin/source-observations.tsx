import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { SourceObservationListItem } from "../../client";
import { SourceObservationListPage } from "../../features/source-observations/ui/source-observation-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { catalogRealtimeRouteTopics } from "../../support/realtime-support/topics";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";
import { CatalogRealtimeReloadActionBar } from "../../support/shell-support/ui/realtime-reload-action-bar";
import { useCatalogRealtimeRevalidation } from "../../support/shell-support/ui/realtime-revalidation";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return loadCatalogListRouteData<SourceObservationListItem>(request, (query) => api.listSourceObservations(query));
}

export const meta: MetaFunction = () => [
  { title: t("catalog.routes.admin.sourceObservations.source.observations.catalog.admin") },
];

export default function SourceObservationsRoute() {
  const routeData = useLoaderData<typeof loader>();
  const realtimeReload = useCatalogRealtimeRevalidation(catalogRealtimeRouteTopics.sourceObservations(), {
    mode: "manual",
  });

  return (
    <SourceObservationListPage
      data={routeData.data}
      query={routeData.query}
      realtimeReloadActionBar={
        realtimeReload.hasPendingChanges ? (
          <CatalogRealtimeReloadActionBar
            pendingChangeCount={realtimeReload.pendingChangeCount}
            syncRequired={realtimeReload.syncRequired}
            reload={realtimeReload.reload}
            entityName={t("catalog.features.sourceObservations.ui.list.source.observations")}
          />
        ) : null
      }
    />
  );
}
