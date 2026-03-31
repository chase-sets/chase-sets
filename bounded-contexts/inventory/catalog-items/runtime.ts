import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { InventoryRuntimeDeps } from "../runtime-support";
import { buildInventoryCatalogItemProjectionHandlers } from "./projection";
import { getInventoryCatalogItem } from "./queries";

export type InventoryCatalogItemServices = Readonly<{
  getCatalogItem: (itemId: string) => ReturnType<typeof getInventoryCatalogItem>;
  projectors: readonly Projector[];
}>;

export function createInventoryCatalogItemRuntime(
  deps: InventoryRuntimeDeps,
): InventoryCatalogItemServices {
  return {
    getCatalogItem: (itemId) => getInventoryCatalogItem(deps.db, itemId),
    projectors: [
      createProjector({
        projectorName: "inventory-catalog-item-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildInventoryCatalogItemProjectionHandlers(deps.db),
      }),
    ],
  };
}
