import type { RepresentativeInventoryServices } from "@chase-sets/catalog-seed";
import type { InventoryServices } from "../runtime-support/services";
import {
  inventoryMutationAttemptFromSource,
  withInventoryMutationAttempt,
  withInventoryMutationTargetAccount,
} from "../runtime-support/mutation-attempt";

export function createInventoryRepresentativeSeedServices(
  services: Pick<InventoryServices, "db" | "items" | "catalogItems">,
): RepresentativeInventoryServices {
  return {
    db: services.db,
    catalogItems: services.catalogItems,
    items: {
      ensureListingStock: (params, context) =>
        services.items.ensureListingStock(
          params,
          withInventoryMutationAttempt(
            withInventoryMutationTargetAccount(context, params.accountId),
            inventoryMutationAttemptFromSource(
              "representative-seed-a985fdbe-2ccb-4b8a-b993-76f3313c5336",
              `${params.accountId}/${params.catalogItemId}`,
            ),
          ),
        ),
    },
  };
}
