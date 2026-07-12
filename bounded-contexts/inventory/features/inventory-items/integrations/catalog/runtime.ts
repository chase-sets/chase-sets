import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { InventoryRuntimeDeps } from "../../../../support/runtime-support";
import { buildInventoryCatalogItemProjectionHandlers } from "./projection";
import {
  getInventoryCatalogItem,
  getInventoryCatalogItemByGtin,
  getInventoryExternalCatalogItemReference,
  getInventoryExternalProductReference,
  searchInventoryCatalogItems,
} from "./queries";

export type InventoryCatalogItemServices = Readonly<{
  getCatalogItem: (itemId: string) => ReturnType<typeof getInventoryCatalogItem>;
  searchCatalogItems: (
    params: Parameters<typeof searchInventoryCatalogItems>[1],
  ) => ReturnType<typeof searchInventoryCatalogItems>;
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
    searchCatalogItems: (params) => searchInventoryCatalogItems(deps.db, params),
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
