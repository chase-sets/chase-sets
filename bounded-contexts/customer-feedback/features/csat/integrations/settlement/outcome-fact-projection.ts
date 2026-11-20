import type { SettlementEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { upsertOutcomeFact } from "../../read-model/outcome-fact-projection";

export function buildSettlementOutcomeFactProjectionHandlers(): ProjectorHandlerMap {
  return defineProjectorHandlers<Pick<SettlementEventPayloads, "settlement.payout.completed">>({
    "settlement.payout.completed": async (event, context) => {
      await upsertOutcomeFact(context?.db as unknown as PgQueryable, {
        idempotencyKey: `settlement:payout.completed:${event.data.payoutId}`,
        outcomeCode: "payout.completed",
        sourceContext: "settlement",
        subjectAccountId: event.data.accountId,
        subjectKind: "seller",
        subjectEntityType: "payout",
        subjectEntityId: event.data.payoutId,
        outcomeOccurredAt: event.data.completedAt,
        sourceEventId: event.id,
        performedByUserId: event.audit.performedByUserId,
        authenticationMethod: null,
        reasonCode: null,
      });
    },
  });
}
