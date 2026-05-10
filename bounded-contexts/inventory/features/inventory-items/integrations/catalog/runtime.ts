import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { InventoryRuntimeDeps } from "../../../../support/runtime-support";
import { buildInventoryCatalogItemProjectionHandlers } from "./projection";
import {
  getInventoryCatalogItem,
  getInventoryExternalProductReference,
} from "./queries";

export type InventoryCatalogItemServices = Readonly<{
  getCatalogItem: (itemId: string) => ReturnType<typeof getInventoryCatalogItem>;
  getExternalProductReference: (
    providerKey: string,
    externalKey: string,
  ) => ReturnType<typeof getInventoryExternalProductReference>;
  projectors: readonly Projector[];
}>;

export function createInventoryCatalogItemRuntime(
  deps: InventoryRuntimeDeps,
): InventoryCatalogItemServices {
  return {
    getCatalogItem: (itemId) => getInventoryCatalogItem(deps.db, itemId),
    getExternalProductReference: (providerKey, externalKey) =>
      getInventoryExternalProductReference(deps.db, providerKey, externalKey),
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
