import { module as catalogModule } from "@chase-sets/catalog";
import {
  module as discoveryModule,
} from "@chase-sets/discovery";
import { createPgPool } from "@chase-sets/event-core-postgres";
import {
  module as fulfillmentModule,
} from "@chase-sets/fulfillment";
import {
  module as marketplaceModule,
} from "@chase-sets/marketplace";
import { createMarketplaceSupplyResolver } from "@chase-sets/marketplace/integration";
import { module as identityModule } from "@chase-sets/identity";
import {
  createInventoryReservationGateway,
  module as inventoryModule,
} from "@chase-sets/inventory";
import {
  createOrderSnapshotReader,
  createOrderingModule,
} from "@chase-sets/ordering";
import {
  createPaymentsModule,
  createFakePaymentProcessorGateway,
} from "@chase-sets/payments";
import {
  module as reputationModule,
} from "@chase-sets/reputation";
import {
  module as settlementModule,
} from "@chase-sets/settlement";
import {
  collectProjectors,
  composeSchemaSql,
  drainProjectors,
  waitForDatabase,
} from "@chase-sets/bounded-context-runtime";
import { loadBootstrapConfig } from "./config";
import { seedMarketplaceStack } from "./seed-stack";

async function bootstrap() {
  const config = loadBootstrapConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await waitForDatabase(pool, "Marketplace API");
    const discovery = discoveryModule.createServices(pool);
    const inventory = inventoryModule.createServices(pool);
    const marketplace = marketplaceModule.createServices(pool);
    const orderingModule = createOrderingModule({
      supplyResolver: createMarketplaceSupplyResolver(marketplace),
      inventoryReservations: createInventoryReservationGateway(inventory),
    });
    const ordering = orderingModule.createServices(pool);
    const paymentsModule = createPaymentsModule({
      processorGateway: createFakePaymentProcessorGateway(),
      getOrderSnapshot: createOrderSnapshotReader(ordering),
    });
    const fulfillment = fulfillmentModule.createServices(pool);
    const reputation = reputationModule.createServices(pool);
    const payments = paymentsModule.createServices(pool);
    const settlement = settlementModule.createServices(pool);
    const modules = [
      catalogModule,
      identityModule,
      inventoryModule,
      discoveryModule,
      marketplaceModule,
      orderingModule,
      fulfillmentModule,
      paymentsModule,
      reputationModule,
      settlementModule,
    ] as const;

    await pool.query(composeSchemaSql(modules));
    await seedMarketplaceStack(pool);
    await drainProjectors(
      collectProjectors([
        inventory,
        discovery,
        marketplace,
        payments,
        fulfillment,
        ordering,
        reputation,
        settlement,
      ]),
    );
    console.log("Marketplace projections are up to date.");
    console.log("Marketplace bootstrap complete.");
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

void bootstrap().catch((error) => {
  console.error("Marketplace bootstrap failed.", error);
  process.exit(1);
});

