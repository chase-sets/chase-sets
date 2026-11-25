import { afterEach, describe, expect, it, vi } from "vitest";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createPlatformApiHost } from "../src/app";
import { apiContextRegistry } from "../src/context-registry";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";

const captured = vi.hoisted(() => ({ ports: undefined as Readonly<Record<string, unknown>> | undefined }));
vi.mock("@chase-sets/platform-runtime/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chase-sets/platform-runtime/api")>();
  return {
    ...actual,
    createApiHost: (...args: Parameters<typeof actual.createApiHost>) => {
      captured.ports = args[2].hostPorts;
      return actual.createApiHost(...args);
    },
  };
});

/**
 * The platform-api composition root is the only supplier of Marketplace's
 * `inventoryItemGradedCardAuthority`. No database is contacted: pool objects are
 * constructed lazily and each test answers the one Inventory read itself.
 */

type MarketplaceOptions = NonNullable<Parameters<typeof marketplaceModule.createServices>[1]>;

function createPools(runtimeProfile: "landing" | "public") {
  return createPlatformApiPools({
    runtimeProfile,
    sharedDatabaseUrl: "postgresql://localhost/shared",
    contextDatabaseUrls: {
      inventory: "postgresql://localhost/inventory",
      marketplace: "postgresql://localhost/marketplace",
    },
    port: 6182,
  });
}

const gradedCard = {
  gradingCompany: "PSA",
  grade: "10",
  certificationNumber: "12345678",
  population: null,
  conditionDescriptors: ["Gem Mint"],
};

/** The `inventory.item.created` row Inventory's event store returns for the item's first stream version. */
function createdRow(accountId: string) {
  return {
    event_id: "evt_graded_card_host_port",
    stream_id: "inventory.item-inv_graded_card_host_port",
    stream_version: 1,
    global_position: "1",
    tenant_id: "tnt_graded_card_host_port",
    stream_context_name: "inventory",
    stream_category: "item",
    event_type: "inventory.item.created",
    payload: { itemId: "inv_graded_card_host_port", accountId, gradedCard },
    metadata: {},
    occurred_at: "2026-11-01T00:00:00.000Z",
    recorded_at: "2026-11-01T00:00:00.000Z",
    performed_by_user_id: "usr_graded_card_host_port",
    for_account_id: accountId,
    trace_id: null,
    span_id: null,
    parent_span_id: null,
    trace_state: null,
  };
}

describe("marketplace-graded-card-inventory-host-port", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes Marketplace an authority that reads the item's first event from the Inventory pool", async () => {
    const pools = createPools("public");
    try {
      const inventoryQuery = vi
        .spyOn(pools.inventory, "query")
        .mockResolvedValue({ rows: [createdRow("acc_owner")] } as never);
      const createServices = vi.spyOn(marketplaceModule, "createServices");

      const runtime = createPlatformApiHost({
        runtimeProfile: "public",
        pools,
        hostPorts: {
          capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
          processorGateway: createFakePaymentProcessorGateway(),
        },
      });

      expect(runtime.mountedContexts.map((entry) => entry.contextName)).toContain("inventory");
      expect(createServices).toHaveBeenCalledOnce();
      const [, options] = createServices.mock.calls[0]!;
      const authority = (options as MarketplaceOptions).inventoryItemGradedCardAuthority;
      expect(authority).toBe(captured.ports?.inventoryItemGradedCardAuthority);
      if (!authority) throw new Error("Marketplace was not given the Inventory graded card authority.");
      expect(inventoryQuery).not.toHaveBeenCalled();

      await expect(
        authority.resolve({ accountId: "acc_owner", inventoryItemId: "inv_graded_card_host_port" }),
      ).resolves.toEqual({ gradedCard });
      await expect(
        authority.resolve({ accountId: "acc_other", inventoryItemId: "inv_graded_card_host_port" }),
      ).resolves.toBeNull();

      expect(inventoryQuery).toHaveBeenCalledTimes(2);
      for (const [sql, values] of inventoryQuery.mock.calls) {
        expect(sql).toContain("FROM event_store_events");
        expect(values).toEqual(["inventory.item-inv_graded_card_host_port", 1, 1]);
      }
    } finally {
      await closePlatformApiPools(pools);
    }
  });

  it("passes none in the landing profile, where Inventory has no pool", async () => {
    const pools = createPools("landing");
    try {
      const createServices = vi.spyOn(marketplaceModule, "createServices");

      const runtime = createPlatformApiHost({
        runtimeProfile: "landing",
        pools,
        hostPorts: { capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" } },
      });

      expect(runtime.mountedContexts.map((entry) => entry.contextName)).not.toContain("inventory");
      expect(captured.ports).toBeDefined();
      expect(captured.ports).not.toHaveProperty("inventoryItemGradedCardAuthority");
      for (const [, options] of createServices.mock.calls) {
        expect((options as MarketplaceOptions).inventoryItemGradedCardAuthority).toBeUndefined();
      }
    } finally {
      await closePlatformApiPools(pools);
    }
  });

  it("declares the authority as a Marketplace host port so the registry forwards it", () => {
    const entry = apiContextRegistry.find((candidate) => candidate.contextName === "marketplace");
    expect(entry).toBeDefined();
    expect((entry?.manifest.hostPorts ?? []).map((port) => port.portName)).toContain(
      "inventoryItemGradedCardAuthority",
    );
  });
});
