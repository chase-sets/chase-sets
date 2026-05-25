import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { InventoryRuntimeDeps } from "../../../../support/runtime-support";
import { buildInventoryCatalogItemProjectionHandlers } from "./projection";
import { getInventoryCatalogItem, getInventoryExternalProductReference } from "./queries";

export type InventoryCatalogItemServices = Readonly<{
  getCatalogItem: (itemId: string) => ReturnType<typeof getInventoryCatalogItem>;
  getExternalProductReference: (
    providerKey: string,
    externalKey: string,
  ) => ReturnType<typeof getInventoryExternalProductReference>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createInventoryCatalogItemRuntime(deps: InventoryRuntimeDeps): InventoryCatalogItemServices {
  return {
    getCatalogItem: (itemId) => getInventoryCatalogItem(deps.db, itemId),
    getExternalProductReference: (providerKey, externalKey) =>
      getInventoryExternalProductReference(deps.db, providerKey, externalKey),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "inventory-catalog-item-projection",
        handlers: buildInventoryCatalogItemProjectionHandlers(deps.db),
      }),
    ],
  };
}
