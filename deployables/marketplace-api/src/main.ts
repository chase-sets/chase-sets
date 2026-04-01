import { serve } from "@hono/node-server";
import { createDiscoveryServices } from "@chase-sets/discovery";
import { startProjectorPolling } from "@chase-sets/event-core/projector-runner";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { resolveActorFromIdentityApi } from "@chase-sets/identity/server";
import { createInventoryServices } from "@chase-sets/inventory";
import { createMarketplaceServices } from "@chase-sets/marketplace-context";
import { createOrderingServices } from "@chase-sets/ordering";
import { loadConfig } from "./config";
import { buildMarketplaceApp } from "./app";

const config = loadConfig();
const pool = createPgPool(config.databaseUrl);
const discovery = createDiscoveryServices(pool);
const inventory = createInventoryServices(pool);
const marketplace = createMarketplaceServices(pool);
const ordering = createOrderingServices(pool, {
  inventoryReservations: {
    createReservation: async ({ sellerAccountId, inventoryRecordId, quantity, reason, notes, context }) => {
      const result = await inventory.holds.createHold(
        {
          accountId: sellerAccountId,
          recordId: inventoryRecordId,
          quantity,
          reason,
          notes,
        },
        context as never,
      );

      return {
        holdId: result.holdId,
        inventoryRecordId,
        sellerAccountId,
        quantity,
      };
    },
    releaseReservation: async ({ sellerAccountId, holdId, context }) => {
      await inventory.holds.releaseHold(
        {
          accountId: sellerAccountId,
          holdId,
        },
        context as never,
      );
    },
  },
});
const app = buildMarketplaceApp(
  { discovery, inventory, marketplace, ordering },
  {
    resolveActor: (request) =>
      resolveActorFromIdentityApi({
        identityApiBaseUrl: config.identityApiBaseUrl,
        request,
      }),
  },
);

const PROJECTION_INTERVAL_MS = 1_000;

startProjectorPolling(
  [
    ...discovery.projectors,
    ...inventory.projectors,
    ...marketplace.projectors,
    ...ordering.projectors,
  ],
  PROJECTION_INTERVAL_MS,
  (error) => {
    console.error("Projection error:", error);
  },
);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Marketplace API listening on port ${info.port}`);
});
