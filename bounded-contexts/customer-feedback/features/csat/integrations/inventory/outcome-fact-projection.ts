import type { InventoryEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { upsertOutcomeFact } from "../../read-model/outcome-fact-projection";

export function buildInventoryOutcomeFactProjectionHandlers(): ProjectorHandlerMap {
  return defineProjectorHandlers<Pick<InventoryEventPayloads, "inventory.item.created" | "inventory.item.adjusted">>({
    "inventory.item.created": async (event, context) => {
      await upsertOutcomeFact(context?.db as unknown as PgQueryable, {
        idempotencyKey: `inventory:item.adjusted:${event.id}`,
        outcomeCode: "inventory.item-adjusted",
        sourceContext: "inventory",
        subjectAccountId: event.data.accountId,
        subjectKind: "seller",
        subjectEntityType: "inventory-item",
        subjectEntityId: event.data.itemId,
        outcomeOccurredAt: event.timing.occurredAt,
        sourceEventId: event.id,
        performedByUserId: event.audit.performedByUserId,
        authenticationMethod: null,
        reasonCode: null,
      });
    },
    "inventory.item.adjusted": async (event, context) => {
      await upsertOutcomeFact(context?.db as unknown as PgQueryable, {
        idempotencyKey: `inventory:item.adjusted:${event.id}`,
        outcomeCode: "inventory.item-adjusted",
        sourceContext: "inventory",
        subjectAccountId: event.audit.forAccountId,
        subjectKind: "seller",
        subjectEntityType: "inventory-item",
        subjectEntityId: event.data.itemId,
        outcomeOccurredAt: event.timing.occurredAt,
        sourceEventId: event.id,
        performedByUserId: event.audit.performedByUserId,
        authenticationMethod: null,
        reasonCode: event.data.reasonCode ?? null,
      });
    },
  });
}
