import type { DiscoveryEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { upsertOutcomeFact } from "../../read-model/outcome-fact-projection";

export function buildDiscoveryOutcomeFactProjectionHandlers(): ProjectorHandlerMap {
  return defineProjectorHandlers<Pick<DiscoveryEventPayloads, "discovery.search-session.started">>({
    "discovery.search-session.started": async (event, context) => {
      await upsertOutcomeFact(context?.db as unknown as PgQueryable, {
        idempotencyKey: `discovery:search-session:${event.data.sessionId}`,
        outcomeCode: "discovery.search-completed",
        sourceContext: "discovery",
        subjectAccountId: event.data.accountId,
        subjectKind: "account",
        subjectEntityType: "session",
        subjectEntityId: event.data.sessionId,
        outcomeOccurredAt: event.timing.recordedAt,
        sourceEventId: event.id,
        performedByUserId: event.audit.performedByUserId,
        authenticationMethod: null,
        reasonCode: null,
      });
    },
  });
}
