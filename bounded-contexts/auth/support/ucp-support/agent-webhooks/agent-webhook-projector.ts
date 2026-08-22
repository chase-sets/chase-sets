import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { AgentWebhookOutbox } from "./agent-webhook-outbox";
import type { AgentWebhookTarget } from "./agent-webhook-registration";
import {
  classifyShipmentDispatchedPayload,
  mapOrderLifecycleEventToOrderUpdate,
  type MappedOrderUpdate,
  type OrderUpdateMappingContext,
} from "./order-update-payload";

export const AGENT_ORDER_WEBHOOK_PROJECTION = "auth-agent-order-webhook-projection";

/**
 * Projects order-lifecycle events onto per-client webhook deliveries.
 *
 * Source events either carry the buyer account or use the preserved historical
 * lookup path. Dispatched payloads are classified atomically before any lookup,
 * so routing values from the event and host projections are never mixed. The
 * projector then fans out one signed delivery per registered agent-platform
 * callback for that account. Enqueue is idempotent per `(client, event, order)`,
 * so replays never double-send.
 */
export type AgentWebhookProjectorDeps = Readonly<{
  outbox: AgentWebhookOutbox;
  /** Registered agent-platform callbacks that should receive updates for an account. */
  resolveWebhookTargets: (accountId: string) => Promise<readonly AgentWebhookTarget[]>;
  /** Buyer account for an order (used when the event omits it). */
  resolveOrderRecipient: (orderId: string) => Promise<string | null>;
  /** Order that a shipment belongs to (dispatch events reference only the shipment). */
  resolveShipmentOrderId: (shipmentId: string) => Promise<string | null>;
}>;

export function buildAgentOrderWebhookProjectionHandlers(deps: AgentWebhookProjectorDeps): ProjectorHandlerMap {
  const handle = (event: TransportEvent) => projectOrderLifecycleEventToAgentWebhooks(deps, event);
  return {
    "ordering.order.created": handle,
    "ordering.order.cancelled": handle,
    "fulfillment.shipment.dispatched": handle,
    "fulfillment.shipment.delivered": handle,
    "payments.refund-issued": handle,
  };
}

export async function projectOrderLifecycleEventToAgentWebhooks(
  deps: AgentWebhookProjectorDeps,
  event: TransportEvent,
): Promise<void> {
  let mappingContext: OrderUpdateMappingContext = {};
  if (event.type === "fulfillment.shipment.dispatched") {
    const classification = classifyShipmentDispatchedPayload(event.data);
    if (classification.kind === "rejected") {
      return;
    }

    const resolvedOrderId =
      classification.kind === "historical" ? await deps.resolveShipmentOrderId(readShipmentId(event)) : null;
    mappingContext = { resolvedOrderId, shipmentDispatchedPayload: classification };
  }

  const mapped = mapOrderLifecycleEventToOrderUpdate(event, mappingContext);
  if (!mapped) {
    return;
  }

  for (const orderId of mapped.orderIds) {
    await enqueueForOrder(deps, event, mapped, orderId);
  }
}

async function enqueueForOrder(
  deps: AgentWebhookProjectorDeps,
  event: TransportEvent,
  mapped: MappedOrderUpdate,
  orderId: string,
): Promise<void> {
  const recipientAccountId = mapped.recipientAccountId ?? (await deps.resolveOrderRecipient(orderId));
  if (!recipientAccountId) {
    return;
  }

  const targets = await deps.resolveWebhookTargets(recipientAccountId);
  if (targets.length === 0) {
    return;
  }

  const payloadJson = JSON.stringify(mapped.buildPayload(orderId));
  for (const target of targets) {
    await deps.outbox.enqueueDelivery({
      clientId: target.clientId,
      accountId: target.accountId,
      callbackUrl: target.callbackUrl,
      sourceEventId: event.id,
      eventType: event.type,
      orderId,
      orderStatus: mapped.status,
      payloadJson,
      idempotencyKey: `${target.clientId}:${event.id}:${orderId}`,
    });
  }
}

function readShipmentId(event: TransportEvent): string {
  const shipmentId = (event.data as { shipmentId?: unknown }).shipmentId;
  return typeof shipmentId === "string" ? shipmentId : "";
}
