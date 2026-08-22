import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createWorkerHost } from "@chase-sets/platform-runtime/worker";
import { module as orderingModule } from "@chase-sets/ordering";
import { workerContextRegistry } from "../src/generated/worker-context-registry";
import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "../src/test-support/provider-gateways";

/**
 * AC-10: the platform-worker composition roots state Ordering's cleanup
 * authority as explicitly not-mounted, and omitting the nonoptional port fails
 * boot (#7199 F2). The worker serves no read API, so `not-mounted` is the
 * truthful variant rather than an omission.
 */

type OrderingServices = ReturnType<typeof orderingModule.createServices>;

function orderingServicesOf(services: Readonly<Record<string, unknown>>): OrderingServices {
  const ordering = services.ordering;
  if (!ordering) {
    throw new Error("Ordering services were not constructed by the worker host.");
  }
  return ordering as OrderingServices;
}

function createUnusedPool() {
  const fail = () => {
    throw new Error("The platform-worker cleanup-authority capability test must not touch database pools.");
  };
  return { query: fail, connect: fail } as never;
}

function workerHostPorts(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    processorGateway: createFakePaymentProcessorGateway(),
    moneyMovementGateway: createFakeMoneyMovementGateway(),
    operationsRecorder: { record: () => undefined },
    postageLabelProvider: createSandboxPostageLabelProvider(),
    draftListingCreator: { createDraftListings: async () => [] },
    notificationAdapter: { send: async () => undefined },
    agentWebhookOrderResolvers: {
      resolveOrderRecipient: async () => null,
      resolveShipmentOrderId: async () => null,
      resolveWebhookTargets: async () => [],
    },
    ...overrides,
  };
}

function createHost(hostPorts: Readonly<Record<string, unknown>>) {
  return createWorkerHost(workerContextRegistry, "platform-worker", {
    pools: Object.fromEntries(workerContextRegistry.map((entry) => [entry.contextName, createUnusedPool()])),
    hostPorts,
    runtimeProfile: "public",
  });
}

function readWorkerSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${relativePath}`, import.meta.url)), "utf8");
}

describe("cleanup-authority-inventory-host-capability", () => {
  it("constructs Ordering with an explicit not-mounted capability from the real worker registry", () => {
    const runtime = createHost(workerHostPorts({ inventoryCleanupAuthority: { kind: "not-mounted" } }));
    const ordering = orderingServicesOf(runtime.services);

    expect(ordering.orders.cleanupAuthority).toEqual({ kind: "not-mounted" });
    // No placeholder observation function exists to be called by mistake.
    expect(Object.keys(ordering.orders.cleanupAuthority)).toEqual(["kind"]);
  });

  it("fails boot when the nonoptional capability is omitted", () => {
    expect(() => createHost(workerHostPorts())).toThrowError(/inventoryCleanupAuthority host capability/);
  });

  it("rejects an unrecognised capability variant rather than degrading", () => {
    expect(() => createHost(workerHostPorts({ inventoryCleanupAuthority: { kind: "maybe-mounted" } }))).toThrowError(
      /must be 'available' or 'not-mounted'/,
    );
    expect(() => createHost(workerHostPorts({ inventoryCleanupAuthority: { kind: "available" } }))).toThrowError(
      /must supply a complete port/,
    );
  });

  it("pins the explicit variant in the worker's module-level composition roots", () => {
    // `main.ts` and `bootstrap.ts` boot the worker as a side effect of import,
    // so their wiring is pinned by source rather than executed here. Both are
    // additionally covered by the repository typecheck and build gates.
    for (const relativePath of ["main.ts", "bootstrap.ts"]) {
      const source = readWorkerSource(relativePath);
      expect({ relativePath, wired: source.includes('inventoryCleanupAuthority: { kind: "not-mounted" }') }).toEqual({
        relativePath,
        wired: true,
      });
    }
  });
});
