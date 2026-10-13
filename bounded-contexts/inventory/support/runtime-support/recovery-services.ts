import type { InventoryItemServices } from "../../features/inventory-items/api/runtime";
import type { InventoryHoldServices } from "../../features/holds/api/runtime";
import type { StorageLocationServices } from "../../features/storage-locations/api/runtime";
import type { InventoryHoldCollisionServices } from "../../features/hold-collisions/api/runtime";
import type { createInventoryMutationRuntime } from "./mutation-attempt";

type MutationRuntime = ReturnType<typeof createInventoryMutationRuntime>;

export function recoverStorageLocations(
  raw: StorageLocationServices,
  mutations: MutationRuntime,
): StorageLocationServices {
  return {
    ...raw,
    createStorageLocation: (params, context) =>
      mutations.execute("location-create", "draft", params.accountId, params, context, () =>
        raw.createStorageLocation(params, context),
      ),
    updateStorageLocation: (params, context) =>
      mutations.execute(
        params.isArchived ? "location-archive" : "location-update",
        params.storageLocationId,
        params.accountId,
        params,
        context,
        () => raw.updateStorageLocation(params, context),
      ),
  };
}

export function recoverInventoryItems(raw: InventoryItemServices, mutations: MutationRuntime): InventoryItemServices {
  return {
    ...raw,
    createItem: (params, context) =>
      mutations.execute("item-create", params.itemIdOverride ?? "draft", params.accountId, params, context, () =>
        raw.createItem(params, context),
      ),
    adjustItem: (params, context) =>
      mutations.execute("item-adjust", params.itemId, params.accountId, params, context, () =>
        raw.adjustItem(params, context),
      ),
    ensureListingStock: (params, context) =>
      mutations.execute("listing-stock-ensure", "listing-stock", params.accountId, params, context, () =>
        raw.ensureListingStock(params, context),
      ),
  };
}

export function recoverInventoryHolds(raw: InventoryHoldServices, mutations: MutationRuntime): InventoryHoldServices {
  return {
    ...raw,
    createHold: (params, context) =>
      mutations.execute("hold-create", params.holdId ?? params.itemId, params.accountId, params, context, () =>
        raw.createHold(params, context),
      ),
    releaseHold: (params, context) =>
      mutations.execute("hold-release", params.holdId, params.accountId, params, context, () =>
        raw.releaseHold(params, context),
      ),
  };
}

export function recoverInventoryReductions(
  raw: InventoryHoldCollisionServices,
  mutations: MutationRuntime,
): InventoryHoldCollisionServices {
  return {
    ...raw,
    reduceItem: (params, context) =>
      params.offlineSale
        ? raw.reduceItem(params, context)
        : mutations.execute("item-adjust", params.itemId, params.accountId, params, context, () =>
            raw.reduceItem(params, context),
          ),
  };
}
