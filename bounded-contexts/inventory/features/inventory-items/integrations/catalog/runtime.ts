import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { InventoryRuntimeDeps } from "../../../../support/runtime-support";
import { buildInventoryCatalogItemProjectionHandlers } from "./projection";
import {
  getInventoryCatalogItem,
  getInventoryCatalogItemByGtin,
  getInventoryExternalCatalogItemReference,
  getInventoryExternalProductReference,
} from "./queries";

export type InventoryCatalogItemServices = Readonly<{
  getCatalogItem: (itemId: string) => ReturnType<typeof getInventoryCatalogItem>;
  getExternalProductReference: (
    providerKey: string,
    externalKey: string,
  ) => ReturnType<typeof getInventoryExternalProductReference>;
  getExternalCatalogItemReference: (
    providerKey: string,
    externalKey: string,
  ) => ReturnType<typeof getInventoryExternalCatalogItemReference>;
  getCatalogItemByGtin: (gtin: string) => ReturnType<typeof getInventoryCatalogItemByGtin>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createInventoryCatalogItemRuntime(deps: InventoryRuntimeDeps): InventoryCatalogItemServices {
  return {
    getCatalogItem: (itemId) => getInventoryCatalogItem(deps.db, itemId),
    getExternalProductReference: (providerKey, externalKey) =>
      getInventoryExternalProductReference(deps.db, providerKey, externalKey),
    getExternalCatalogItemReference: (providerKey, externalKey) =>
      getInventoryExternalCatalogItemReference(deps.db, providerKey, externalKey),
    getCatalogItemByGtin: (gtin) => getInventoryCatalogItemByGtin(deps.db, gtin),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "inventory-catalog-item-projection",
        handlers: buildInventoryCatalogItemProjectionHandlers(deps.db),
      }),
    ],
  };
}
