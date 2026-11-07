import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { InventoryDraftListingConsumer, MarketplaceServices } from "@chase-sets/marketplace/server";
import { createPlatformApiInventoryDraftListingConsumer } from "../src/inventory-draft-listing-consumer";
import { createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";

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

describe("issue-7169-c4-consumer-rollout platform-api", () => {
  it("calls the actual Marketplace consumer constructed by the real host and registry, without a fake receiver", async () => {
    const pools = createPlatformApiPools({
      runtimeProfile: "public",
      sharedDatabaseUrl: "postgresql://localhost/shared",
      contextDatabaseUrls: {
        inventory: "postgresql://localhost/inventory",
        ordering: "postgresql://localhost/ordering",
      },
      port: 6182,
    });
    try {
      const runtime = createPlatformApiHost({
        runtimeProfile: "public",
        pools,
        hostPorts: {
          capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
          processorGateway: createFakePaymentProcessorGateway(),
        },
      });
      const port = captured.ports?.inventoryDraftListingConsumer as InventoryDraftListingConsumer;
      expect(captured.ports?.draftListingDelivery).toBe(port);
      // direct-draft-bypass control: the composition root binds only the outbox delivery port.
      expect(captured.ports).not.toHaveProperty("draftListingCreator");
      const owner = runtime.services.marketplace as MarketplaceServices;
      const accept = vi.spyOn(owner.inventoryDraftListingConsumer, "accept");
      const context = {
        tenantId: "tnt_c4",
        audit: { performedByUserId: "usr_c4", forAccountId: "acc_c4" },
      } as EventStoreContext;
      await expect(port.accept({}, context)).rejects.toMatchObject({ code: "inventory-draft-conflict" });
      expect(accept).toHaveBeenCalledExactlyOnceWith({}, context);
    } finally {
      await closePlatformApiPools(pools);
    }
  });
  it("binds the imported consumer type, forwarding message and trusted context without reconstruction", async () => {
    const receipt = { synthetic: "receipt" };
    const accept = vi.fn(async () => receipt as never);
    const readReceipt = vi.fn(async () => null);
    const owner: Pick<MarketplaceServices, "inventoryDraftListingConsumer"> = {
      inventoryDraftListingConsumer: { accept, readReceipt },
    };
    const port: InventoryDraftListingConsumer = createPlatformApiInventoryDraftListingConsumer(() => owner);
    const message = { synthetic: "opaque-message" };
    const context = {
      tenantId: "tnt_c4",
      audit: { performedByUserId: "usr_c4", forAccountId: "acc_c4" },
    } as EventStoreContext;
    expect(await port.accept(message, context)).toBe(receipt);
    expect(accept).toHaveBeenCalledExactlyOnceWith(message, context);
    expect(await port.readReceipt("imr_c4_1", context)).toBeNull();
    expect(readReceipt).toHaveBeenCalledExactlyOnceWith("imr_c4_1", context);
  });

  it("fails closed when the context is not mounted, rather than accepting a placeholder", async () => {
    const port = createPlatformApiInventoryDraftListingConsumer(() => undefined);
    const context = {
      tenantId: "tnt_c4",
      audit: { performedByUserId: "usr_c4", forAccountId: "acc_c4" },
    } as EventStoreContext;
    await expect(port.accept({}, context)).rejects.toMatchObject({
      code: "inventory-draft-unavailable",
      diagnostic: "consumer-unbound",
    });
  });

  it("keeps the real composition root bound before any Inventory producer is enabled (unbound-consumer-port control)", () => {
    const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    expect(source).toContain("createPlatformApiInventoryDraftListingConsumer(");
    expect(/hostPorts:\s*\{\s*inventoryDraftListingConsumer,/.test(source)).toBe(true);
    expect(source).toContain("draftListingDelivery: inventoryDraftListingConsumer");
    expect(source).toContain("runtime?.services.marketplace as MarketplaceServices | undefined");
    expect(source).not.toContain("draftListingCreator");
    expect(source).not.toContain("createBatchDraftListingFromInventorySnapshot");
  });
});
