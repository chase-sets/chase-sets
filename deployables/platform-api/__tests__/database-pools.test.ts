import { describe, expect, it } from "vitest";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing-testing";
import { createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";

describe("platform api database pools", () => {
  it("reuses one pool when every context falls back to DATABASE_URL", async () => {
    const pools = createPlatformApiPools({
      sharedDatabaseUrl: "postgresql://localhost/chase_sets",
      contextDatabaseUrls: {},
      port: 6182,
    });

    try {
      expect(pools.auth).toBe(pools.catalog);
      expect(pools.catalog).toBe(pools.payments);
    } finally {
      await closePlatformApiPools(pools);
    }
  });

  it("supports mixed per-context pools while the host still mounts every context", async () => {
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
