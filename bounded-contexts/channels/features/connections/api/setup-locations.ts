import { createInventoryRequestApiClient } from "@chase-sets/inventory/server";

export async function readConnectionSetupLocations(request: Request) {
  const locations = await createInventoryRequestApiClient(request).listStorageLocations(
    "includeArchived=false&limit=200",
  );
  return locations.items.map((item) => ({ storageLocationId: item.storage_location_id, name: item.name }));
}
