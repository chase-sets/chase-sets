import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { type CatalogItemListItem } from "../../client";
import { CatalogItemListPage } from "../../features/catalog-items/ui/catalog-item-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { catalogRealtimeRouteTopics } from "../../support/realtime-support/topics";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";
import { CatalogRealtimeReloadActionBar } from "../../features/catalog-items/ui/realtime-reload-action-bar";
import { CatalogRealtimeConnectionStatus } from "../../support/shell-support/ui/realtime-connection-status";
import { useCatalogRealtimeRevalidation } from "../../support/shell-support/ui/realtime-revalidation";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return loadCatalogListRouteData<CatalogItemListItem>(request, (query) => api.listCatalogItems(query));
}

export const meta: MetaFunction = () => [{ title: t("catalog.routes.admin.catalogItems.catalog.items.catalog.admin") }];

export default function CatalogItemsRoute() {
  const routeData = useLoaderData<typeof loader>();
  const realtimeReload = useCatalogRealtimeRevalidation(catalogRealtimeRouteTopics.catalogItems(), { mode: "manual" });

  return (
    <CatalogItemListPage
      data={routeData.data}
      query={routeData.query}
      connectionStatus={
        <CatalogRealtimeConnectionStatus
          status={realtimeReload.connectionStatus}
          staleSince={realtimeReload.connectionStaleSince}
          reload={realtimeReload.reload}
        />
      }
      realtimeReloadActionBar={
        realtimeReload.hasPendingChanges ? (
          <CatalogRealtimeReloadActionBar
            pendingChangeCount={realtimeReload.pendingChangeCount}
            syncRequired={realtimeReload.syncRequired}
            reload={realtimeReload.reload}
            entityName={t("catalog.features.catalogItems.ui.catalogItemListPage.catalog.items")}
          />
        ) : null
      }
    />
  );
}
