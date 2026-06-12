import { describe, expect, it } from "vitest";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";

describe("platform api database pools", () => {
  it("binds the shared pool factory to the platform API host registry", async () => {
    const pools = createPlatformApiPools({
      sharedDatabaseUrl: "postgresql://localhost/shared",
      contextDatabaseUrls: {
        auth: "postgresql://localhost/auth",
        payments: "postgresql://localhost/payments",
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
      expect(runtime.mountedContexts.length).toBeGreaterThan(0);
      expect(runtime.mountedContexts.find((entry) => entry.contextName === "auth")?.pool).toBe(pools.auth);
      expect(runtime.mountedContexts.find((entry) => entry.contextName === "payments")?.pool).toBe(pools.payments);
    } finally {
      await closePlatformApiPools(pools);
    }
  });
});
