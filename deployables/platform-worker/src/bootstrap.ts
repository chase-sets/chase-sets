import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { bootstrapPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { createWorkerHost } from "@chase-sets/platform-runtime/worker";
import { loadConfig } from "./config";
import { closePlatformWorkerPools, createPlatformWorkerPools } from "./database-pools";
import { workerContextRegistry } from "./context-registry";
import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "./test-support/provider-gateways";

const config = loadConfig();
const pools = createPlatformWorkerPools(config);

try {
  await bootstrapPlatformControlPlane(pools.control);
  const runtime = createWorkerHost(workerContextRegistry, "platform-worker", {
    pools,
    runtimeProfile: config.runtimeProfile,
    hostPorts: {
      processorGateway: createFakePaymentProcessorGateway(),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      operationsRecorder: { record: () => undefined },
      postageLabelProvider: createSandboxPostageLabelProvider(),
    },
  });

  for (const context of runtime.mountedContexts) {
    await bootstrapContextDatabase(context.module, context.pool);
  }

  console.log("platform-worker bootstrap complete.");
} finally {
  await closePlatformWorkerPools(pools);
}
