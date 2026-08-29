import { describe, expect, it } from "vitest";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createApiHost } from "@chase-sets/platform-runtime/api";
import { module as orderingModule } from "@chase-sets/ordering";
import { createPlatformApiHost } from "../src/app";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";

/**
 * AC-10: the platform-api composition root supplies Ordering's required
 * cleanup-authority capability from the real registry, and Ordering fails boot
 * when the nonoptional port is absent (#7199 F2). No database is contacted:
 * pool objects are constructed lazily and `createServices` never queries.
 */

type OrderingServices = ReturnType<typeof orderingModule.createServices>;

function orderingServicesOf(services: Readonly<Record<string, unknown>>): OrderingServices {
  const ordering = services.ordering;
  if (!ordering) {
    throw new Error("Ordering services were not constructed by the host.");
  }
  return ordering as OrderingServices;
}

function createPools(runtimeProfile: "landing" | "public") {
  return createPlatformApiPools({
    runtimeProfile,
    sharedDatabaseUrl: "postgresql://localhost/shared",
    contextDatabaseUrls: {
      inventory: "postgresql://localhost/inventory",
      ordering: "postgresql://localhost/ordering",
    },
    port: 6182,
  });
}

describe("cleanup-authority-inventory-host-capability", () => {
  it("supplies the available variant from the real platform-api registry", async () => {
    const pools = createPools("public");
    try {
      const runtime = createPlatformApiHost({
        runtimeProfile: "public",
        pools,
        hostPorts: { processorGateway: createFakePaymentProcessorGateway() },
      });
      const ordering = orderingServicesOf(runtime.services);

      expect(ordering.orders.cleanupAuthority.kind).toBe("available");
      if (ordering.orders.cleanupAuthority.kind !== "available") {
        throw new Error("expected an available capability");
      }
      // A real function, not a placeholder object.
      expect(typeof ordering.orders.cleanupAuthority.observeBuyerOrderCleanupAuthority).toBe("function");
      expect(typeof ordering.orders.cleanupAuthority.observeEvidenceWindowSourceCleanupAuthority).toBe("function");
      expect(runtime.mountedContexts.map((entry) => entry.contextName)).toContain("inventory");
    } finally {
      await closePlatformApiPools(pools);
    }
  });

  it("states not-mounted in the landing profile, where Ordering is source-only and Inventory has no pool", async () => {
    const pools = createPools("landing");
    try {
      const runtime = createPlatformApiHost({ runtimeProfile: "landing", pools, hostPorts: {} });
      const ordering = orderingServicesOf(runtime.services);

      expect(runtime.mountedContexts.map((entry) => entry.contextName)).not.toContain("inventory");
      // The honest variant for a host with no Inventory pool: an explicit
      // not-mounted, never a fabricated stub.
      expect(ordering.orders.cleanupAuthority.kind).toBe("not-mounted");
    } finally {
      await closePlatformApiPools(pools);
    }
  });

  it("fails boot when the nonoptional capability is absent from the supplied host ports", async () => {
    const pools = createPools("public");
    try {
      // Bypasses createPlatformApiHost, which is the only supplier of this
      // port: the registry resolves `undefined` for it and Ordering refuses.
      expect(() =>
        createApiHost(apiContextRegistry, "platform-api", {
          pools,
          runtimeProfile: "public",
          hostPorts: { processorGateway: createFakePaymentProcessorGateway() },
        }),
      ).toThrowError(/inventoryCleanupAuthority host capability/);
    } finally {
      await closePlatformApiPools(pools);
    }
  });

  it("declares the capability as an Ordering host port so the registry forwards it", () => {
    const entry = apiContextRegistry.find((candidate) => candidate.contextName === "ordering");
    expect(entry).toBeDefined();
    expect((entry?.manifest.hostPorts ?? []).map((port) => port.portName)).toContain("inventoryCleanupAuthority");
  });
});
