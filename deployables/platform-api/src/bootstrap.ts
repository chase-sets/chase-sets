import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing-testing";
import { createFakeMoneyMovementGateway } from "@chase-sets/money-movement-testing";
import { seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import { createPlatformApiHost } from "./app";
import { loadBootstrapConfig } from "./config";
import { closePlatformApiPools, createPlatformApiPools } from "./database-pools";
import { apiContextRegistry } from "./generated/api-context-registry";

async function bootstrap() {
  const config = loadBootstrapConfig();
  const pools = createPlatformApiPools(config);

  try {
    const runtime = createPlatformApiHost({
      pools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
        moneyMovementGateway: createFakeMoneyMovementGateway(),
      },
    });
    await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime);
    console.log("Platform API bootstrap complete.");
  } finally {
    await closePlatformApiPools(pools);
  }
}

void bootstrap().catch((error) => {
  console.error("Platform API bootstrap failed.", error);
  process.exit(1);
});
