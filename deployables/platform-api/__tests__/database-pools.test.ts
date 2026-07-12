import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";

describe("platform api database pools", () => {
  it("binds the shared pool factory to the platform API host registry", async () => {
    const pools = createPlatformApiPools({
      runtimeProfile: "public",
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
        runtimeProfile: "public",
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
      const options = (
        pools.auth as unknown as {
          options: {
            idle_in_transaction_session_timeout?: number;
            options?: string;
            onConnect: (client: unknown) => Promise<void>;
          };
        }
      ).options;

      expect(options.idle_in_transaction_session_timeout).toBeUndefined();
      expect(options.options).toBeUndefined();
      const client = createFakeClient();
      await options.onConnect(client);
      expect(client.query).toHaveBeenCalledWith("SELECT set_config('idle_in_transaction_session_timeout', $1, false)", [
        "15000ms",
      ]);
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

  it("binds landing profile pools to the landing context set", async () => {
    const pools = createPlatformApiPools({
      runtimeProfile: "landing",
      sharedDatabaseUrl: "postgresql://localhost/shared",
      contextDatabaseUrls: {},
      port: 6182,
    });

    try {
      const runtime = createPlatformApiHost({
        runtimeProfile: "landing",
        pools,
        hostPorts: {},
      });
      const mountedContextNames = runtime.mountedContexts.map((entry) => entry.contextName);

      expect(mountedContextNames).toEqual([
        "auth",
        "catalog",
        "fulfillment",
        "identity",
        "marketplace",
        "ordering",
        "platform-operations",
        "public-presence",
      ]);
      expect(mountedContextNames).not.toContain("checkout");
      expect(mountedContextNames).not.toContain("payments");
      expect(mountedContextNames).not.toContain("settlement");
    } finally {
      await closePlatformApiPools(pools);
    }
  });
});

function createFakeClient(): EventEmitter & { query: ReturnType<typeof vi.fn> } {
  const client = new EventEmitter() as EventEmitter & { query: ReturnType<typeof vi.fn> };
  client.query = vi.fn(async () => undefined);
  return client;
}
