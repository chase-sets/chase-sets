import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { createWorkerHost } from "@chase-sets/platform-runtime/worker";
import { module as orderingModule } from "@chase-sets/ordering";
import type { IdentityServices } from "@chase-sets/identity/server";
import type { PricingHostPorts } from "@chase-sets/pricing/server";
import { workerContextRegistry } from "../src/generated/worker-context-registry";
import { createPlatformChannelSaleRecorder } from "../src/channels-reconciliation-runners";
import { createRegisteredScheduledRunners, createSupportEvidenceCleanupHostPort } from "../src/scheduled-runners";
import { livenessConfig } from "./channels-liveness-config";
import {
  parseSupportEvidenceCleanupBinding,
  type PlatformOperationsServices,
} from "@chase-sets/platform-operations/server";
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
const syntheticPricingHostPorts = {
  tcgplayerMarketTransport: { kind: "not-mounted" },
  tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
  commercialTermsResolver: createNoopCommercialTermsResolver(),
  channelConnectionIdentityReader: { resolve: async () => null },
} satisfies PricingHostPorts;

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
  const pool = createUnusedPool();
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
    channelSaleRecorder: createPlatformChannelSaleRecorder(pool),
    ...syntheticPricingHostPorts,
    ...overrides,
  };
}

function createHost(hostPorts: Readonly<Record<string, unknown>>) {
  return createWorkerHost(workerContextRegistry, "platform-worker", {
    pools: Object.fromEntries(workerContextRegistry.map((entry) => [entry.contextName, createUnusedPool()])),
    hostPorts: {
      capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
      ...hostPorts,
    },
    runtimeProfile: "public",
  });
}

function readWorkerSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${relativePath}`, import.meta.url)), "utf8");
}

describe("cleanup-authority-inventory-host-capability", () => {
  it("mounts Identity with explicit deny-all, never starts a receipt and refuses omitted administration port", async () => {
    const runtime = createHost(workerHostPorts({ inventoryCleanupAuthority: { kind: "not-mounted" } }));
    const identity = runtime.services.identity as IdentityServices;
    await expect(identity.accountCapabilities.initializeAdministrationAuthority()).resolves.toBeNull();
    await expect(
      identity.accountCapabilities.grantAccountCapability(
        {
          admission: { tenantId: "tnt_synthetic", administratorUserId: "usr_synthetic" } as never,
          accountCapabilityRegistry: [],
          accountId: "acc_synthetic",
          capabilityKey: "support.evidence.any-case",
          expectedVersion: 0,
        },
        {
          tenantId: "tnt_synthetic" as never,
          audit: { performedByUserId: "usr_synthetic" as never, forAccountId: "acc_synthetic" as never },
        },
      ),
    ).rejects.toThrow();
    expect(() =>
      createHost(
        workerHostPorts({
          capabilityAdministrationAuthority: undefined,
          inventoryCleanupAuthority: { kind: "not-mounted" },
        }),
      ),
    ).toThrow(/capabilityAdministrationAuthority host capability/);
    expect(readWorkerSource("main.ts")).toContain("...identityHostPorts");
    expect(readWorkerSource("main.ts")).toContain('kind: "deny-all"');
  });
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

  it("pins the explicit variant in the worker runtime composition root", () => {
    // `main.ts` boots the worker as a side effect of import, so its wiring is
    // pinned by source rather than executed here. The schema-only bootstrap
    // executable intentionally constructs no services or runners.
    const source = readWorkerSource("main.ts");
    expect(source).toContain('inventoryCleanupAuthority: { kind: "not-mounted" }');
  });
});

describe("support-evidence-cleanup-host-capability (AC-E4)", () => {
  const instance = '["support-deployment-instance/v1","test","release-a"]';
  const scope = { environment: "test", deploymentInstance: instance, implementationSha: "a".repeat(40) };
  const binding = parseSupportEvidenceCleanupBinding(
    JSON.stringify({
      version: 1,
      environment: "test",
      deploymentInstance: instance,
      bindingId: "cleanup-test",
      revision: 1,
      active: true,
    }),
    scope,
  );
  const store = {
    putPrivate: vi.fn(),
    readPrivate: vi.fn(),
    verifyPrivate: vi.fn(),
    listPrivate: vi.fn(),
    deleteKeys: vi.fn(),
  };
  function compose(supportEvidenceCleanupBinding: typeof binding) {
    const port = createSupportEvidenceCleanupHostPort(
      {
        deploymentEnvironment: "test",
        supportEvidenceCleanupBinding,
        supportEvidenceStorage: { kind: "filesystem", rootDir: "unused", publicBaseUrl: "http://unused.invalid" },
      },
      { info: () => undefined },
      () => store,
    );
    const runtime = createHost(workerHostPorts({ inventoryCleanupAuthority: { kind: "not-mounted" }, ...port }));
    const services = runtime.services["platform-operations"] as PlatformOperationsServices;
    const names = createRegisteredScheduledRunners({
      services: runtime.services,
      config: { ...livenessConfig, supportEvidenceCleanupIntervalMs: 1 },
      controlPlane: {} as never,
      logger: { info: () => undefined, warn: () => undefined },
      workSignalCleanup: () => ({ workSignalStore: {} as never, intervalMs: 1 }),
      retentionSweep: () => ({ targets: [] }),
    }).map((runner) => runner.name);
    return { services, names };
  }

  it("registers the cleanup runner only when the real worker registry composes a valid binding", () => {
    const mounted = compose(binding);
    expect(mounted.services.supportRequests.attachmentCleanup.kind).toBe("available");
    expect(mounted.names.filter((name) => name === "support-evidence-operation-cleanup")).toHaveLength(1);
    for (const denied of [
      { kind: "denied", diagnostic: "binding_absent" },
      { kind: "denied", diagnostic: "binding_inactive" },
    ] as const) {
      const unmounted = compose(denied);
      expect(unmounted.services.supportRequests.attachmentCleanup).toEqual({ kind: "not-mounted" });
      expect(unmounted.names).not.toContain("support-evidence-operation-cleanup");
    }
    // Composition never reaches put, read or listing on the shared private store.
    for (const method of [store.putPrivate, store.readPrivate, store.listPrivate])
      expect(method).not.toHaveBeenCalled();
  });

  it("rejects a malformed capability rather than degrading to a mounted runner", () => {
    expect(() =>
      createHost(
        workerHostPorts({
          inventoryCleanupAuthority: { kind: "not-mounted" },
          supportEvidenceCleanup: { kind: "available", binding, storage: { putPrivate: vi.fn() } },
        }),
      ),
    ).toThrowError(/Support evidence cleanup capability/);
  });

  it("pins the configured port in the worker runtime composition root", () => {
    const source = readWorkerSource("main.ts");
    expect(source).toContain("createSupportEvidenceCleanupHostPort(config, logger)");
    expect(source).toContain("...supportEvidenceCleanupHostPort");
  });
});
