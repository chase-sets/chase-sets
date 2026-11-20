import type { PlatformOperationsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { upsertOutcomeFact } from "../../read-model/outcome-fact-projection";

export function buildSupportOutcomeFactProjectionHandlers(): ProjectorHandlerMap {
  return defineProjectorHandlers<Pick<PlatformOperationsEventPayloads, "support.support-request.resolved">>({
    "support.support-request.resolved": async (event, context) => {
      const isReturn = event.data.flowType === "return-request";
      await upsertOutcomeFact(context?.db as unknown as PgQueryable, {
        idempotencyKey: `support-request:${event.data.supportRequestId}:resolved`,
        outcomeCode: isReturn ? "return.resolved" : "support.request-resolved",
        sourceContext: "platform-operations",
        subjectAccountId: event.data.buyerAccountId,
        subjectKind: "buyer",
        subjectEntityType: isReturn ? "return" : "support-request",
        subjectEntityId: event.data.supportRequestId,
        outcomeOccurredAt: event.data.resolution.resolvedAt,
        sourceEventId: event.id,
        performedByUserId: event.audit.performedByUserId,
        authenticationMethod: null,
        reasonCode: null,
      });
    },
  });
}
