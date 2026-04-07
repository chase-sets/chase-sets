import { createPgPool } from "@chase-sets/event-core-postgres";
import { drainContextRuntime } from "@chase-sets/bounded-context-runtime";
import { loadBootstrapConfig } from "./config";
import { seedContextRuntimeIfEmpty } from "./context-lifecycle.generated";
import { createContextRuntime } from "./context-runtime.generated";
import { createFakePaymentProcessorGateway } from "./payment-processor";

async function bootstrap() {
  const config = loadBootstrapConfig();
  const pools = {
    catalog: createPgPool(config.databaseUrls.catalog),
    discovery: createPgPool(config.databaseUrls.discovery),
    fulfillment: createPgPool(config.databaseUrls.fulfillment),
    identity: createPgPool(config.databaseUrls.identity),
    inventory: createPgPool(config.databaseUrls.inventory),
    marketplace: createPgPool(config.databaseUrls.marketplace),
    ordering: createPgPool(config.databaseUrls.ordering),
    payments: createPgPool(config.databaseUrls.payments),
    pricing: createPgPool(config.databaseUrls.pricing),
    reputation: createPgPool(config.databaseUrls.reputation),
    settlement: createPgPool(config.databaseUrls.settlement),
  } as const;

  try {
    const runtime = createContextRuntime(pools, {
      processorGateway: createFakePaymentProcessorGateway(),
    });
    await seedContextRuntimeIfEmpty(pools, runtime);
    await drainContextRuntime(runtime);
    console.log("Marketplace projections are up to date.");
    console.log("Marketplace bootstrap complete.");
  } finally {
    await Promise.all(
      Object.values(pools).map((pool) =>
        (pool as unknown as { end: () => Promise<void> }).end(),
      ),
    );
  }
}

void bootstrap().catch((error) => {
  console.error("Marketplace bootstrap failed.", error);
  process.exit(1);
});

