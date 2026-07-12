import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type {
  AgentWebhookOutbox,
  ClaimedAgentWebhookDelivery,
  EnqueueAgentWebhookDeliveryInput,
} from "./agent-webhook-outbox";
import { createAgentWebhookDispatcher, type AgentWebhookSendRequest } from "./agent-webhook-dispatcher";
import { projectOrderLifecycleEventToAgentWebhooks } from "./agent-webhook-projector";
import type { AgentWebhookTarget } from "./agent-webhook-registration";
import { AGENT_WEBHOOK_SIGNATURE_HEADER, verifyAgentWebhookSignature } from "./webhook-signing";

const signingSecret = "whsec_lifecycle_fixture";
const target: AgentWebhookTarget = {
  clientId: "ocl_lifecycle",
  accountId: "acc_buyer",
  callbackUrl: "https://agent.example/hooks",
};

describe("agent webhook lifecycle", () => {
  it("projects the full order lifecycle to an in-process signed receiver", async () => {
    const enqueued: EnqueueAgentWebhookDeliveryInput[] = [];
    const sent: string[] = [];
    const outbox = createInProcessOutbox(enqueued);

    const events: readonly [string, Record<string, unknown>][] = [
      ["ordering.order.created", { orderId: "ord_1", buyerAccountId: "acc_buyer" }],
      ["fulfillment.shipment.dispatched", { shipmentId: "shp_1" }],
      ["fulfillment.shipment.delivered", { shipmentId: "shp_1", orderId: "ord_1", buyerAccountId: "acc_buyer" }],
      ["ordering.order.cancelled", { orderId: "ord_1", reason: "buyer-request" }],
      ["payments.refund-issued", { refundId: "ref_1", orderIds: ["ord_1"], amount: "12.00", currencyCode: "USD" }],
    ];

    for (const [index, [type, data]] of events.entries()) {
      await projectOrderLifecycleEventToAgentWebhooks(
        {
          outbox,
          resolveWebhookTargets: async () => [target],
          resolveOrderRecipient: async () => "acc_buyer",
          resolveShipmentOrderId: async () => "ord_1",
        },
        fixtureEvent(type, data, `evt_${index + 1}`),
      );
    }

    const dispatcher = createAgentWebhookDispatcher({
      outbox,
      resolveSigningSecret: async () => signingSecret,
      send: async (request: AgentWebhookSendRequest) => {
        expect(request.url).toBe(target.callbackUrl);
        const signature = request.headers[AGENT_WEBHOOK_SIGNATURE_HEADER];
        expect(
          verifyAgentWebhookSignature({
            signingSecret,
            body: request.body,
            header: signature,
            nowSeconds: Math.floor(new Date("2026-07-12T00:00:00.000Z").getTime() / 1000),
          }),
        ).toBe(true);
        sent.push(JSON.parse(request.body).order.status);
        return { status: 202 };
      },
      claimOwnerId: "worker-in-process",
      now: () => new Date("2026-07-12T00:00:00.000Z"),
    });

    await dispatcher.runOnce();

    expect(enqueued.map((delivery) => delivery.orderStatus)).toEqual([
      "created",
      "shipped",
      "delivered",
      "cancelled",
      "refunded",
    ]);
    expect(sent).toEqual(["created", "shipped", "delivered", "cancelled", "refunded"]);
  });
});

function createInProcessOutbox(enqueued: EnqueueAgentWebhookDeliveryInput[]): AgentWebhookOutbox {
  return {
    enqueueDelivery: async (input) => {
      enqueued.push(input);
    },
    claimPendingDeliveries: async () =>
      enqueued.map(
        (input, index): ClaimedAgentWebhookDelivery => ({
          outboxId: String(index + 1),
          deliveryId: input.idempotencyKey,
          clientId: input.clientId,
          accountId: input.accountId,
          callbackUrl: input.callbackUrl,
          sourceEventId: input.sourceEventId,
          eventType: input.eventType,
          orderId: input.orderId,
          orderStatus: input.orderStatus,
          payloadJson: input.payloadJson,
          status: "sending",
          attemptCount: 1,
          maxAttempts: 8,
          nextAttemptAt: "2026-07-12T00:00:00.000Z",
          lastError: null,
        }),
      ),
    renewClaim: async () => true,
    markDelivered: async () => undefined,
    markFailed: async () => undefined,
    listForClient: async () => [],
    listDeadLettered: async () => [],
  };
}

function fixtureEvent(type: string, data: Record<string, unknown>, id: string): TransportEvent {
  return {
    id,
    type,
    streamId: "order-stream-1",
    streamVersion: 1,
    globalPosition: id,
    tenantId: "tenant_1",
    data,
    metadata: {},
    audit: { performedByUserId: "user_1", forAccountId: "acc_buyer" },
    trace: { traceId: `trace-${id}` },
    timing: { occurredAt: "2026-07-12T00:00:00.000Z", recordedAt: "2026-07-12T00:00:00.000Z" },
  } as unknown as TransportEvent;
}
