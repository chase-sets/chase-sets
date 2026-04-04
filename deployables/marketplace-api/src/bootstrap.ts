import { createPgPool } from "@chase-sets/event-core-postgres";
import {
  createFakePaymentProcessorGateway,
} from "@chase-sets/payments";
import {
  composeSchemaSql,
  waitForDatabase,
} from "@chase-sets/bounded-context-runtime";
import { loadBootstrapConfig } from "./config";
import { createContextRuntime } from "./context-runtime.generated";
import { seedMarketplaceRuntime } from "./seed-stack";

async function bootstrap() {
  const config = loadBootstrapConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await waitForDatabase(pool, "Marketplace API");
    const runtime = createContextRuntime(pool, {
      processorGateway: createFakePaymentProcessorGateway(),
    });

    await pool.query(composeSchemaSql(runtime.mountedModules.map(({ module }) => module)));
    await seedMarketplaceRuntime(pool, runtime);
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

