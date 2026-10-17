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

type RoutingCell = "ok" | "abs" | "" | 42 | null;
type DispatchRoutingMatrixRow = Readonly<{
  row: string;
  orderId: RoutingCell;
  buyerAccountId: RoutingCell;
  sellerAccountId: RoutingCell;
  trackingIdentifier: RoutingCell;
  outcome: "historical" | "enriched" | "rejected";
}>;

const dispatchRoutingMatrix = [
  {
    row: "C1",
    orderId: "abs",
    buyerAccountId: "abs",
    sellerAccountId: "abs",
    trackingIdentifier: "abs",
    outcome: "historical",
  },
  {
    row: "C2",
    orderId: "ok",
    buyerAccountId: "ok",
    sellerAccountId: "ok",
    trackingIdentifier: "ok",
    outcome: "enriched",
  },
  {
    row: "C3",
    orderId: "ok",
    buyerAccountId: "ok",
    sellerAccountId: "ok",
    trackingIdentifier: null,
    outcome: "enriched",
  },
  {
    row: "M1",
    orderId: "ok",
    buyerAccountId: "abs",
    sellerAccountId: "abs",
    trackingIdentifier: "abs",
    outcome: "rejected",
  },
  {
    row: "M2",
    orderId: "abs",
    buyerAccountId: "ok",
    sellerAccountId: "abs",
    trackingIdentifier: "abs",
    outcome: "rejected",
  },
  {
    row: "M3",
    orderId: "ok",
    buyerAccountId: "ok",
    sellerAccountId: "abs",
    trackingIdentifier: "abs",
    outcome: "rejected",
  },
  {
    row: "M4",
    orderId: "abs",
    buyerAccountId: "abs",
    sellerAccountId: "ok",
    trackingIdentifier: "abs",
    outcome: "rejected",
  },
  {
    row: "M5",
    orderId: "ok",
    buyerAccountId: "abs",
    sellerAccountId: "ok",
    trackingIdentifier: "abs",
    outcome: "rejected",
  },
  {
    row: "M6",
    orderId: "abs",
    buyerAccountId: "ok",
    sellerAccountId: "ok",
    trackingIdentifier: "abs",
    outcome: "rejected",
  },
  {
    row: "M7",
    orderId: "ok",
    buyerAccountId: "ok",
    sellerAccountId: "ok",
    trackingIdentifier: "abs",
    outcome: "rejected",
  },
  {
    row: "M8",
    orderId: "abs",
    buyerAccountId: "abs",
    sellerAccountId: "abs",
    trackingIdentifier: "ok",
    outcome: "rejected",
  },
  {
    row: "M9",
    orderId: "ok",
    buyerAccountId: "abs",
    sellerAccountId: "abs",
    trackingIdentifier: "ok",
    outcome: "rejected",
  },
  {
    row: "M10",
    orderId: "abs",
    buyerAccountId: "ok",
    sellerAccountId: "abs",
    trackingIdentifier: "ok",
    outcome: "rejected",
  },
  {
    row: "M11",
    orderId: "ok",
    buyerAccountId: "ok",
    sellerAccountId: "abs",
    trackingIdentifier: "ok",
    outcome: "rejected",
  },
  {
    row: "M12",
    orderId: "abs",
    buyerAccountId: "abs",
    sellerAccountId: "ok",
    trackingIdentifier: "ok",
    outcome: "rejected",
  },
  {
    row: "M13",
    orderId: "ok",
    buyerAccountId: "abs",
    sellerAccountId: "ok",
    trackingIdentifier: "ok",
    outcome: "rejected",
  },
  {
    row: "M14",
    orderId: "abs",
    buyerAccountId: "ok",
    sellerAccountId: "ok",
    trackingIdentifier: "ok",
    outcome: "rejected",
  },
  {
    row: "E1",
    orderId: "",
    buyerAccountId: "ok",
    sellerAccountId: "ok",
    trackingIdentifier: "ok",
    outcome: "rejected",
  },
  {
    row: "E2",
    orderId: "ok",
    buyerAccountId: "",
    sellerAccountId: "ok",
    trackingIdentifier: "ok",
    outcome: "rejected",
  },
  {
    row: "E3",
    orderId: "ok",
    buyerAccountId: "ok",
    sellerAccountId: "",
    trackingIdentifier: "ok",
    outcome: "rejected",
  },
  {
    row: "T1",
    orderId: 42,
    buyerAccountId: "ok",
    sellerAccountId: "ok",
    trackingIdentifier: "ok",
    outcome: "rejected",
  },
  {
    row: "T2",
    orderId: "ok",
    buyerAccountId: 42,
    sellerAccountId: "ok",
    trackingIdentifier: "ok",
    outcome: "rejected",
  },
  {
    row: "T3",
    orderId: "ok",
    buyerAccountId: "ok",
    sellerAccountId: 42,
    trackingIdentifier: "ok",
    outcome: "rejected",
  },
  {
    row: "T4",
    orderId: "ok",
    buyerAccountId: "ok",
    sellerAccountId: "ok",
    trackingIdentifier: 42,
    outcome: "rejected",
  },
] as const satisfies readonly DispatchRoutingMatrixRow[];

function dispatchedPayload(row: DispatchRoutingMatrixRow): Record<string, unknown> {
  const data: Record<string, unknown> = {
    shipmentId: "shp_1",
    dispatchedAt: "2026-07-08T00:00:00.000Z",
  };
  const validValues = {
    orderId: "ord_1",
    buyerAccountId: "acc_buyer",
    sellerAccountId: "acc_seller",
    trackingIdentifier: "1Z999",
  } as const;

  for (const key of ["orderId", "buyerAccountId", "sellerAccountId", "trackingIdentifier"] as const) {
    const cell = row[key];
    if (cell !== "abs") {
      data[key] = cell === "ok" ? validValues[key] : cell;
    }
  }
  return data;
}

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

  it("skips an order whose recipient cannot be resolved", async () => {
    const { outbox, enqueued } = collectingOutbox();
    const resolveWebhookTargets = vi.fn(async () => targets);
    await projectOrderLifecycleEventToAgentWebhooks(
      {
        outbox,
        resolveWebhookTargets,
        resolveOrderRecipient: async () => null,
        resolveShipmentOrderId: async () => null,
      },
      event("ordering.order.cancelled", { orderId: "ord_1", reason: "payment-deadline" }),
    );
    expect(enqueued).toHaveLength(0);
    expect(resolveWebhookTargets).not.toHaveBeenCalled();
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

  it.each(dispatchRoutingMatrix)("classifies dispatched routing row $row as $outcome", async (matrixRow) => {
    const { outbox } = collectingOutbox();
    const resolveShipmentOrderId = vi.fn(async () => "ord_legacy");
    const resolveOrderRecipient = vi.fn(async () => "acc_buyer");
    const resolveWebhookTargets = vi.fn(async () => targets);

    await projectOrderLifecycleEventToAgentWebhooks(
      { outbox, resolveWebhookTargets, resolveOrderRecipient, resolveShipmentOrderId },
      event("fulfillment.shipment.dispatched", dispatchedPayload(matrixRow)),
    );

    if (matrixRow.outcome === "rejected") {
      expect(resolveShipmentOrderId).not.toHaveBeenCalled();
      expect(resolveOrderRecipient).not.toHaveBeenCalled();
      expect(resolveWebhookTargets).not.toHaveBeenCalled();
      expect(outbox.enqueueDelivery).not.toHaveBeenCalled();
      return;
    }

    if (matrixRow.outcome === "historical") {
      expect(resolveShipmentOrderId).toHaveBeenCalledWith("shp_1");
      expect(resolveOrderRecipient).toHaveBeenCalledWith("ord_legacy");
    } else {
      expect(resolveShipmentOrderId).not.toHaveBeenCalled();
      expect(resolveOrderRecipient).not.toHaveBeenCalled();
    }
    expect(resolveWebhookTargets).toHaveBeenCalledWith("acc_buyer");
    expect(outbox.enqueueDelivery).toHaveBeenCalledTimes(2);
  });

  it("routes a completely enriched dispatch from the event without host lookups", async () => {
    const { outbox, enqueued } = collectingOutbox();
    const resolveShipmentOrderId = vi.fn(async () => "ord_wrong");
    const resolveOrderRecipient = vi.fn(async () => "acc_wrong");
    const resolveWebhookTargets = vi.fn(async () => targets);

    await projectOrderLifecycleEventToAgentWebhooks(
      { outbox, resolveWebhookTargets, resolveOrderRecipient, resolveShipmentOrderId },
      event("fulfillment.shipment.dispatched", {
        shipmentId: "shp_1",
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        trackingIdentifier: "1Z999",
      }),
    );

    expect(resolveShipmentOrderId).not.toHaveBeenCalled();
    expect(resolveOrderRecipient).not.toHaveBeenCalled();
    expect(resolveWebhookTargets).toHaveBeenCalledWith("acc_buyer");
    expect(
      enqueued.map((entry) => ({ orderId: entry.orderId, clientId: entry.clientId, accountId: entry.accountId })),
    ).toEqual([
      { orderId: "ord_1", clientId: "ocl_1", accountId: "acc_buyer" },
      { orderId: "ord_1", clientId: "ocl_2", accountId: "acc_buyer" },
    ]);
  });

  it("fans an enriched dispatch out only to the buyer account's registered targets", async () => {
    const { outbox, enqueued } = collectingOutbox();
    const targetsByAccount: Readonly<Record<string, readonly AgentWebhookTarget[]>> = {
      acc_buyer: [{ clientId: "ocl_buyer", accountId: "acc_buyer", callbackUrl: "https://buyer.example/hooks" }],
      acc_other: [{ clientId: "ocl_other", accountId: "acc_other", callbackUrl: "https://other.example/hooks" }],
    };
    const resolveWebhookTargets = vi.fn(async (accountId: string) => targetsByAccount[accountId] ?? []);

    await projectOrderLifecycleEventToAgentWebhooks(
      {
        outbox,
        resolveWebhookTargets,
        resolveOrderRecipient: vi.fn(async () => "acc_other"),
        resolveShipmentOrderId: vi.fn(async () => "ord_other"),
      },
      event("fulfillment.shipment.dispatched", {
        shipmentId: "shp_1",
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        trackingIdentifier: null,
      }),
    );

    expect(resolveWebhookTargets).toHaveBeenCalledTimes(1);
    expect(resolveWebhookTargets).toHaveBeenCalledWith("acc_buyer");
    expect(enqueued.map((entry) => ({ clientId: entry.clientId, accountId: entry.accountId }))).toEqual([
      { clientId: "ocl_buyer", accountId: "acc_buyer" },
    ]);
  });

  it("keeps per-client idempotency keys stable across duplicate enriched projection calls", async () => {
    const { outbox, enqueued } = collectingOutbox();
    const deps = {
      outbox,
      resolveWebhookTargets: async () => targets,
      resolveOrderRecipient: vi.fn(async () => null),
      resolveShipmentOrderId: vi.fn(async () => null),
    };
    const dispatched = event("fulfillment.shipment.dispatched", {
      shipmentId: "shp_1",
      orderId: "ord_1",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      trackingIdentifier: "1Z999",
    });

    await projectOrderLifecycleEventToAgentWebhooks(deps, dispatched);
    await projectOrderLifecycleEventToAgentWebhooks(deps, dispatched);

    expect(enqueued.map((entry) => entry.idempotencyKey)).toEqual([
      "ocl_1:evt_1:ord_1",
      "ocl_2:evt_1:ord_1",
      "ocl_1:evt_1:ord_1",
      "ocl_2:evt_1:ord_1",
    ]);
    expect(new Set(enqueued.map((entry) => entry.idempotencyKey))).toEqual(
      new Set(["ocl_1:evt_1:ord_1", "ocl_2:evt_1:ord_1"]),
    );
  });

  it("fans a multi-order refund out per order, resolving each order's recipient independently", async () => {
    const { outbox, enqueued } = collectingOutbox();
    const recipientByOrder: Record<string, string> = { ord_1: "acc_buyer", ord_2: "acc_other" };
    const targetsByAccount: Record<string, readonly AgentWebhookTarget[]> = {
      acc_buyer: [{ clientId: "ocl_1", accountId: "acc_buyer", callbackUrl: "https://a.example/hooks" }],
      acc_other: [{ clientId: "ocl_2", accountId: "acc_other", callbackUrl: "https://b.example/hooks" }],
    };
    await projectOrderLifecycleEventToAgentWebhooks(
      {
        outbox,
        resolveWebhookTargets: async (accountId) => targetsByAccount[accountId] ?? [],
        resolveOrderRecipient: async (orderId) => recipientByOrder[orderId] ?? null,
        resolveShipmentOrderId: async () => null,
      },
      event("payments.refund-issued", { refundId: "rf_1", orderIds: ["ord_1", "ord_2"] }),
    );
    expect(enqueued.map((entry) => ({ orderId: entry.orderId, clientId: entry.clientId }))).toEqual([
      { orderId: "ord_1", clientId: "ocl_1" },
      { orderId: "ord_2", clientId: "ocl_2" },
    ]);
    expect(enqueued.every((entry) => entry.orderStatus === "refunded")).toBe(true);
    expect(new Set(enqueued.map((entry) => entry.idempotencyKey)).size).toBe(2);
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
