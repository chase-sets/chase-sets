import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { InventoryServices } from "./support/runtime-support/services";
import { inventoryCatalogItemRoutes } from "./support/catalog-item-support/route";
import { inventoryCheckoutReservationRoutes, inventoryHoldRoutes } from "./features/holds/api/route";
import { inventoryImportBatchRoutes } from "./features/import-batches/api/route";
import { inventoryItemRoutes } from "./features/inventory-items/api/route";
import { inventoryRestockDecisionRoutes } from "./features/restock-decisions/api/route";
import { inventoryStorageLocationRoutes } from "./features/storage-locations/api/route";
import { inventoryRecoveredItemRoutes } from "./features/recovered-items/api/route";

export type InventoryActor = Readonly<{
  accountId: string;
  permissions: readonly string[];
}>;

export type InventoryApiEnv = {
  Variables: {
    actor: InventoryActor;
    context: EventStoreContext;
  };
};

function requiredPermissionForMethod(method: string, path: string) {
  if (path.includes("/recovered-items")) {
    return method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD"
      ? "recovered-inventory.view"
      : "recovered-inventory.manage";
  }
  if (method.toUpperCase() === "POST" && path.includes("/checkout-reservations")) {
    return "orders.manage";
  }

  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return "inventory.view";
    default:
      return "inventory.manage";
  }
}

export function buildInventoryApi(services: InventoryServices) {
  const app = new Hono<InventoryApiEnv>();

  app.use("*", async (c, next) => {
    const actor = c.get("actor");
    if (!actor) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: "Authentication required.",
          },
        },
        401,
      );
    }

    const requiredPermission = requiredPermissionForMethod(c.req.method, c.req.path);
    if (
      !actor.permissions.includes(requiredPermission) &&
      !(requiredPermission === "orders.manage" && actor.permissions.includes("guest-checkout.manage"))
    ) {
      return c.json(
        {
          error: {
            code: "authorization_forbidden",
            message: "Forbidden.",
          },
        },
        403,
      );
    }

    await next();
  });

  app.route("/catalog-items", inventoryCatalogItemRoutes(services.catalogItems));
  app.route("/storage-locations", inventoryStorageLocationRoutes(services.storageLocations));
  app.route("/import-batches", inventoryImportBatchRoutes(services.importBatches));
  app.route("/items", inventoryItemRoutes(services.items, services.holds));
  app.route("/restock-decisions", inventoryRestockDecisionRoutes(services.restockDecisions));
  app.route("/recovered-items", inventoryRecoveredItemRoutes(services.recoveredItems));
  app.route("/holds", inventoryHoldRoutes(services.holds));
  app.route("/checkout-reservations", inventoryCheckoutReservationRoutes(services.holds));

  return app;
}
