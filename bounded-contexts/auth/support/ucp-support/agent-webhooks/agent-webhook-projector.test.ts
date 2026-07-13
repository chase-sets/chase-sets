import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { AgentWebhookOutbox, EnqueueAgentWebhookDeliveryInput } from "./agent-webhook-outbox";
import type { AgentWebhookTarget } from "./agent-webhook-registration";
import {
  buildAgentOrderWebhookProjectionHandlers,
  projectOrderLifecycleEventToAgentWebhooks,
} from "./agent-webhook-projector";

function event(type: string, data: Record<string, unknown>, id = "evt_1"): TransportEvent {
  return buildTransportEvent(type, data, {
    id,
    streamId: "stream_1",
    globalPosition: "1",
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_actor" },
    trace: { traceId: "trace_1" },
    timing: { occurredAt: "2026-07-08T00:00:00.000Z", recordedAt: "2026-07-08T00:00:00.000Z" },
  });
}

function collectingOutbox() {
  const enqueued: EnqueueAgentWebhookDeliveryInput[] = [];
  const outbox = {
    enqueueDelivery: vi.fn(async (input: EnqueueAgentWebhookDeliveryInput) => {
      enqueued.push(input);
    }),
  } as unknown as AgentWebhookOutbox;
  return { outbox, enqueued };
}

const targets: readonly AgentWebhookTarget[] = [
  { clientId: "ocl_1", accountId: "acc_buyer", callbackUrl: "https://a.example/hooks" },
  { clientId: "ocl_2", accountId: "acc_buyer", callbackUrl: "https://b.example/hooks" },
];

describe("agent order webhook projector", () => {
  it("fans a created order out to every registered callback with a stable idempotency key", async () => {
    const { outbox, enqueued } = collectingOutbox();
    await projectOrderLifecycleEventToAgentWebhooks(
      {
        outbox,
        resolveWebhookTargets: async () => targets,
        resolveOrderRecipient: async () => null,
        resolveShipmentOrderId: async () => null,
      },
      event("ordering.order.created", { orderId: "ord_1", buyerAccountId: "acc_buyer" }),
    );
    expect(enqueued.map((entry) => entry.clientId)).toEqual(["ocl_1", "ocl_2"]);
    expect(enqueued[0].idempotencyKey).toBe("ocl_1:evt_1:ord_1");
    expect(enqueued[0].orderStatus).toBe("created");
    expect(enqueued[0].callbackUrl).toBe("https://a.example/hooks");
  });

  it("resolves the recipient account for events that omit it", async () => {
    const { outbox, enqueued } = collectingOutbox();
    const resolveOrderRecipient = vi.fn(async () => "acc_buyer");
    await projectOrderLifecycleEventToAgentWebhooks(
      {
        outbox,
        resolveWebhookTargets: async () => targets,
        resolveOrderRecipient,
        resolveShipmentOrderId: async () => null,
      },
      event("ordering.order.cancelled", { orderId: "ord_1", reason: "payment-deadline" }),
    );
    expect(resolveOrderRecipient).toHaveBeenCalledWith("ord_1");
    expect(enqueued).toHaveLength(2);
  });

  it("resolves the order for a shipment dispatch before mapping", async () => {
    const { outbox, enqueued } = collectingOutbox();
    const resolveShipmentOrderId = vi.fn(async () => "ord_7");
    await projectOrderLifecycleEventToAgentWebhooks(
      {
        outbox,
        resolveWebhookTargets: async () => targets,
        resolveOrderRecipient: async () => "acc_buyer",
        resolveShipmentOrderId,
      },
      event("fulfillment.shipment.dispatched", { shipmentId: "shp_1" }),
    );
    expect(resolveShipmentOrderId).toHaveBeenCalledWith("shp_1");
    expect(enqueued[0].orderId).toBe("ord_7");
    expect(enqueued[0].orderStatus).toBe("shipped");
  });

  it("enqueues nothing when the account has no registered callbacks", async () => {
    const { outbox, enqueued } = collectingOutbox();
    await projectOrderLifecycleEventToAgentWebhooks(
      {
        outbox,
        resolveWebhookTargets: async () => [],
        resolveOrderRecipient: async () => "acc_buyer",
        resolveShipmentOrderId: async () => null,
      },
      event("ordering.order.created", { orderId: "ord_1", buyerAccountId: "acc_buyer" }),
    );
    expect(enqueued).toHaveLength(0);
  });

  it("skips a dispatch that cannot be tied back to an order", async () => {
    const { outbox, enqueued } = collectingOutbox();
    await projectOrderLifecycleEventToAgentWebhooks(
      {
        outbox,
        resolveWebhookTargets: async () => targets,
        resolveOrderRecipient: async () => "acc_buyer",
        resolveShipmentOrderId: async () => null,
      },
      event("fulfillment.shipment.dispatched", { shipmentId: "shp_1" }),
    );
    expect(enqueued).toHaveLength(0);
  });

  it("registers handlers for exactly the order lifecycle events", () => {
    const handlers = buildAgentOrderWebhookProjectionHandlers({
      outbox: collectingOutbox().outbox,
      resolveWebhookTargets: async () => [],
      resolveOrderRecipient: async () => null,
      resolveShipmentOrderId: async () => null,
    });
    expect(Object.keys(handlers).sort()).toEqual([
      "fulfillment.shipment.delivered",
      "fulfillment.shipment.dispatched",
      "ordering.order.cancelled",
      "ordering.order.created",
      "payments.refund-issued",
    ]);
  });
});
