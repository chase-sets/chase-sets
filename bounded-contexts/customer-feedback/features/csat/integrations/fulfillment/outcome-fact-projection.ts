import type { FulfillmentEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { upsertOutcomeFact } from "../../read-model/outcome-fact-projection";

export function buildFulfillmentOutcomeFactProjectionHandlers(): ProjectorHandlerMap {
  return defineProjectorHandlers<Pick<FulfillmentEventPayloads, "fulfillment.shipment.delivered">>({
    "fulfillment.shipment.delivered": async (event, context) => {
      await upsertOutcomeFact(context?.db as unknown as PgQueryable, {
        idempotencyKey: `order:${event.data.orderId}:delivered`,
        outcomeCode: "order.delivered",
        sourceContext: "fulfillment",
        subjectAccountId: event.data.buyerAccountId,
        subjectKind: "buyer",
        subjectEntityType: "order",
        subjectEntityId: event.data.orderId,
        outcomeOccurredAt: event.data.deliveredAt,
        sourceEventId: event.id,
        performedByUserId: event.audit.performedByUserId,
        authenticationMethod: null,
        reasonCode: null,
      });
    },
  });
}
