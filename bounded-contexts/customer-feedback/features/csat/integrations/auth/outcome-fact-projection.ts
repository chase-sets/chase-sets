import type { AuthEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { upsertOutcomeFact } from "../../read-model/outcome-fact-projection";

export function buildAuthOutcomeFactProjectionHandlers(): ProjectorHandlerMap {
  return defineProjectorHandlers<Pick<AuthEventPayloads, "auth.session.started">>({
    "auth.session.started": async (event, context) => {
      await upsertOutcomeFact(context?.db as unknown as PgQueryable, {
        idempotencyKey: `auth:authentication:${event.data.sessionId}`,
        outcomeCode: "authentication.completed",
        sourceContext: "auth",
        subjectAccountId: event.data.accountId,
        subjectKind: "account",
        subjectEntityType: "session",
        subjectEntityId: event.data.sessionId,
        outcomeOccurredAt: event.timing.recordedAt,
        sourceEventId: event.id,
        performedByUserId: event.audit.performedByUserId,
        authenticationMethod: event.data.authenticationMethod,
        reasonCode: null,
      });
    },
  });
}
