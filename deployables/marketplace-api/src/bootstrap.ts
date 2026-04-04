import { createPgPool } from "@chase-sets/event-core-postgres";
import {
  createFakePaymentProcessorGateway,
} from "@chase-sets/payments";
import {
  collectProjectors,
  composeSchemaSql,
  drainProjectors,
  waitForDatabase,
} from "@chase-sets/bounded-context-runtime";
import { loadBootstrapConfig } from "./config";
import { seedMarketplaceStack } from "./seed-stack";
import { composeMarketplaceApiStack } from "./stack";

async function bootstrap() {
  const config = loadBootstrapConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await waitForDatabase(pool, "Marketplace API");
    const { mountedModules, services } = composeMarketplaceApiStack(pool, {
      processorGateway: createFakePaymentProcessorGateway(),
    });

    await pool.query(composeSchemaSql(mountedModules.map(({ module }) => module)));
    await seedMarketplaceStack(pool);
    await drainProjectors(
      collectProjectors([
        services.inventory,
        services.discovery,
        services.marketplace,
        services.payments,
        services.fulfillment,
        services.ordering,
        services.reputation,
        services.settlement,
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

