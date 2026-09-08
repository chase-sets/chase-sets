import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { module as channelsModule } from "@chase-sets/channels";
import { createCommercialTermsResolver, type CommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { bootstrapPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { createWorkerHost, type WorkerHostRuntime } from "@chase-sets/platform-runtime/worker";
import type { ChannelConnectionIdentityReader, PricingHostPorts } from "@chase-sets/pricing/server";
import { loadConfig } from "./config";
import { closePlatformWorkerPools, createPlatformWorkerPools } from "./database-pools";
import { workerContextRegistry } from "./generated/worker-context-registry";
import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "./test-support/provider-gateways";

const config = loadConfig();
const pools = createPlatformWorkerPools(config);

try {
  await bootstrapPlatformControlPlane(pools.control);
  let runtime: WorkerHostRuntime | null = null;
  const commercialTermsResolver = pools["commercial-terms"]
    ? createCommercialTermsResolver({ db: pools["commercial-terms"] })
    : undefined;
  const pricingHostPorts: PricingHostPorts | undefined = pools.pricing
    ? {
        tcgplayerMarketTransport: { kind: "not-mounted" },
        tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
        commercialTermsResolver: requirePricingCommercialTermsResolver(commercialTermsResolver),
        channelConnectionIdentityReader: createChannelConnectionIdentityReader(
          () => runtime?.services.channels as ReturnType<typeof channelsModule.createServices> | undefined,
        ),
      }
    : undefined;

  runtime = createWorkerHost(workerContextRegistry, "platform-worker", {
    pools,
    runtimeProfile: config.runtimeProfile,
    hostPorts: {
      processorGateway: createFakePaymentProcessorGateway(),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      operationsRecorder: { record: () => undefined },
      postageLabelProvider: createSandboxPostageLabelProvider(),
      ...(pricingHostPorts ?? {}),
      // See main.ts: the worker never serves the Ordering cleanup-authority
      // read surface, and states that explicitly.
      inventoryCleanupAuthority: { kind: "not-mounted" },
    },
  });

  for (const context of runtime.mountedContexts) {
    await bootstrapContextDatabase(context.module, context.pool);
  }

  console.log("platform-worker bootstrap complete.");
} finally {
  await closePlatformWorkerPools(pools);
}

function createChannelConnectionIdentityReader(
  getServices: () => ReturnType<typeof channelsModule.createServices> | undefined,
): ChannelConnectionIdentityReader {
  return {
    resolve: async (input) => {
      const connection = await getServices()?.connections.getConnection(input);
      return connection
        ? {
            connectionId: connection.connectionId,
            providerKey: connection.providerKey,
            environment: connection.environment,
          }
        : null;
    },
  };
}

function requirePricingCommercialTermsResolver(resolver: CommercialTermsResolver | undefined): CommercialTermsResolver {
  if (!resolver) {
    throw new Error("Pricing cannot be mounted without the Commercial Terms resolver host port.");
  }
  return resolver;
}
