import { describe, expect, it } from "vitest";
import { createWorkerHost } from "@chase-sets/platform-runtime/worker";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import type { module as fulfillmentModule } from "@chase-sets/fulfillment";
import { workerContextRegistry } from "../src/generated/worker-context-registry";
import { createPlatformChannelSaleRecorder } from "../src/channels-reconciliation-runners";
import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "../src/test-support/provider-gateways";

describe("Shipment Group admission worker host capability", () => {
  it("composes the real worker registry with no admission port and no database access", () => {
    const fail = () => {
      throw new Error("No database access is allowed during this composition proof.");
    };
    const pool = { query: fail, connect: fail };
    const hostPorts = {
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
      inventoryCleanupAuthority: { kind: "not-mounted" },
      tcgplayerMarketTransport: { kind: "not-mounted" },
      tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
      commercialTermsResolver: createNoopCommercialTermsResolver(),
      channelConnectionIdentityReader: { resolve: async () => null },
    };
    expect(hostPorts).not.toHaveProperty("shipmentGroupAdmissionAuthority");
    const runtime = createWorkerHost(workerContextRegistry, "platform-worker", {
      pools: Object.fromEntries(workerContextRegistry.map((entry) => [entry.contextName, pool])),
      hostPorts,
      runtimeProfile: "public",
    });
    const fulfillment = runtime.services.fulfillment as ReturnType<typeof fulfillmentModule.createServices>;
    expect(Object.keys(fulfillment.shipments.shipmentGroupAdmissionAuthority).sort()).toEqual([
      "abort",
      "commit",
      "reserve",
    ]);
    expect(Object.keys(fulfillment.shipments.shipmentGroupAdmissionHandlers)).toHaveLength(5);
    const admission = runtime.subscriptionRunners.find(
      (runner) => runner.projectionName === "fulfillment-order-group-admission-subscription",
    );
    expect(admission).toMatchObject({
      sourceContextName: "ordering",
      targetContextName: "fulfillment",
      checkpointKey: "fulfillment-order-group-admission-subscription:ordering:v1",
      order: 15,
    });
    expect(runtime.projectionGroups.find((group) => group.projectionName === admission?.projectionName)).toMatchObject({
      ownedTables: [],
      requiredDuringBootstrap: true,
      resetStrategy: "replay-only",
    });
    expect(
      runtime.subscriptionRunners.find((runner) => runner.projectionName === "fulfillment-order-source-projection"),
    ).toMatchObject({ checkpointKey: "fulfillment-order-source-projection:ordering:v1", order: 20 });
  });
});
