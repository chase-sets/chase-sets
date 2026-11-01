import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { InventoryDraftListingConsumer, MarketplaceServices } from "@chase-sets/marketplace/server";
import { createPlatformWorkerInventoryDraftListingConsumer } from "../src/inventory-draft-listing-consumer";
import { createWorkerHost } from "@chase-sets/platform-runtime/worker";
import { workerContextRegistry } from "../src/context-registry";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { createPlatformChannelSaleRecorder } from "../src/channels-reconciliation-runners";
import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "../src/test-support/provider-gateways";

describe("issue-7169-c4-consumer-rollout platform-worker", () => {
  it("calls the actual Marketplace consumer constructed by the real host and registry, without a fake receiver", async () => {
    let runtime: ReturnType<typeof createWorkerHost> | null = null;
    const port = createPlatformWorkerInventoryDraftListingConsumer(
      () => runtime?.services.marketplace as MarketplaceServices | undefined,
    );
    const query = vi.fn(() => {
      throw new Error("Malformed messages must never contact a database");
    });
    runtime = createWorkerHost(workerContextRegistry, "platform-worker", {
      pools: Object.fromEntries(workerContextRegistry.map((entry) => [entry.contextName, { query, connect: query }])),
      runtimeProfile: "public",
      hostPorts: {
        inventoryDraftListingConsumer: port,
        inventoryCleanupAuthority: { kind: "not-mounted" },
        capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
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
        channelSaleRecorder: createPlatformChannelSaleRecorder({ query, connect: query }),
        commercialTermsResolver: createNoopCommercialTermsResolver(),
        channelConnectionIdentityReader: { resolve: async () => null },
      },
    });
    const owner = runtime.services.marketplace as MarketplaceServices;
    const accept = vi.spyOn(owner.inventoryDraftListingConsumer, "accept");
    const context = {
      tenantId: "tnt_c4",
      audit: { performedByUserId: "usr_c4", forAccountId: "acc_c4" },
    } as EventStoreContext;
    await expect(port.accept({}, context)).rejects.toMatchObject({ code: "inventory-draft-conflict" });
    expect(accept).toHaveBeenCalledExactlyOnceWith({}, context);
    expect(query).not.toHaveBeenCalled();
  });
  it("binds the imported consumer type, forwarding message and trusted context without reconstruction", async () => {
    const receipt = { synthetic: "receipt" };
    const accept = vi.fn(async () => receipt as never);
    const readReceipt = vi.fn(async () => null);
    const owner: Pick<MarketplaceServices, "inventoryDraftListingConsumer"> = {
      inventoryDraftListingConsumer: { accept, readReceipt },
    };
    const port: InventoryDraftListingConsumer = createPlatformWorkerInventoryDraftListingConsumer(() => owner);
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
    const port = createPlatformWorkerInventoryDraftListingConsumer(() => undefined);
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
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source).toContain("createPlatformWorkerInventoryDraftListingConsumer(");
    expect(/hostPorts:\s*\{\s*inventoryDraftListingConsumer,/.test(source)).toBe(true);
    expect(source).toContain("draftListingDelivery: inventoryDraftListingConsumer");
    expect(source).toContain("runtime?.services.marketplace as MarketplaceServices | undefined");
    expect(source).toContain("draftListingCreator,");
  });
});
