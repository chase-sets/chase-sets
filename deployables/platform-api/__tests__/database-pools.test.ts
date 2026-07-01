import { describe, expect, it } from "vitest";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";

describe("platform api database pools", () => {
  it("binds the shared pool factory to the platform API host registry", async () => {
    const pools = createPlatformApiPools({
      sharedDatabaseUrl: "postgresql://localhost/shared",
      workSignalDatabaseUrl: "postgresql://localhost/control-direct",
      contextDatabaseUrls: {
        auth: "postgresql://localhost/auth",
        catalog: "postgresql://localhost/catalog",
        payments: "postgresql://localhost/payments",
      },
      contextWaiterDatabaseUrls: {
        catalog: "postgresql://localhost/catalog-direct",
      },
      port: 6182,
    });

    try {
      const runtime = createPlatformApiHost({
        pools,
        hostPorts: {
          processorGateway: createFakePaymentProcessorGateway(),
        },
      });

      expect(pools.auth).not.toBe(pools.catalog);
      expect(pools.payments).not.toBe(pools.catalog);
      expect(pools.workSignal).not.toBe(pools.control);
      expect(pools.contextWaiters.catalog).not.toBe(pools.catalog);
      expect(pools.contextWaiters.auth).toBe(pools.auth);
      expect(runtime.mountedContexts.length).toBeGreaterThan(0);
      expect(runtime.mountedContexts.find((entry) => entry.contextName === "auth")?.pool).toBe(pools.auth);
      expect(runtime.mountedContexts.find((entry) => entry.contextName === "catalog")?.pool).toBe(pools.catalog);
      expect(runtime.mountedContexts.find((entry) => entry.contextName === "catalog")?.notificationWaiterPool).toBe(
        pools.contextWaiters.catalog,
      );
      expect(runtime.mountedContexts.find((entry) => entry.contextName === "payments")?.pool).toBe(pools.payments);
    } finally {
      await closePlatformApiPools(pools);
    }
  });
});
