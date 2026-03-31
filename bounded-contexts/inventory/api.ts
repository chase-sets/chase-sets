import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { InventoryServices } from "./services";
import { inventoryCatalogItemRoutes } from "./catalog-items/route";
import { inventoryHoldRoutes } from "./holds/route";
import { inventoryRecordRoutes } from "./records/route";
import { inventoryStorageLocationRoutes } from "./storage-locations/route";

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

function requiredPermissionForMethod(method: string) {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return "inventory.view";
    default:
      return "inventory.manage";
  }
}

async function drainProjectors(services: InventoryServices) {
  let processed = 0;
  do {
    processed = 0;
    for (const projector of services.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export function buildInventoryApi(services: InventoryServices) {
  const app = new Hono<InventoryApiEnv>();

  app.use("*", async (c, next) => {
    const actor = c.get("actor");
    if (!actor) {
      return c.json({ error: "Authentication required." }, 401);
    }

    const requiredPermission = requiredPermissionForMethod(c.req.method);
    if (!actor.permissions.includes(requiredPermission)) {
      return c.json({ error: "Forbidden." }, 403);
    }

    await next();

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await drainProjectors(services);
    }
  });

  app.route(
    "/catalog-items",
    inventoryCatalogItemRoutes(services.catalogItems),
  );
  app.route(
    "/storage-locations",
    inventoryStorageLocationRoutes(services.storageLocations),
  );
  app.route("/records", inventoryRecordRoutes(services.records, services.holds));
  app.route("/holds", inventoryHoldRoutes(services.holds));

  return app;
}
