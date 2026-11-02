import type { IdentityEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { upsertOutcomeFact } from "../../read-model/outcome-fact-projection";

export function buildIdentityOutcomeFactProjectionHandlers(): ProjectorHandlerMap {
  return defineProjectorHandlers<
    Pick<IdentityEventPayloads, "identity.registration.completed" | "identity.onboarding.completed">
  >({
    "identity.registration.completed": async (event, context) => {
      await upsertOutcomeFact(context?.db as unknown as PgQueryable, {
        idempotencyKey: `identity:registration:${event.data.accountId}`,
        outcomeCode: "registration.completed",
        sourceContext: "identity",
        subjectAccountId: event.data.accountId,
        subjectKind: "account",
        subjectEntityType: "account",
        subjectEntityId: event.data.accountId,
        outcomeOccurredAt: event.timing.recordedAt,
        sourceEventId: event.id,
        performedByUserId: event.audit.performedByUserId,
        authenticationMethod: null,
        reasonCode: null,
      });
    },
    "identity.onboarding.completed": async (event, context) => {
      await upsertOutcomeFact(context?.db as unknown as PgQueryable, {
        idempotencyKey:
          event.data.onboardingPath === "invitation"
            ? `identity:onboarding:invitation:${event.data.invitationId}:${event.data.userId}`
            : `identity:onboarding:guest-account:${event.data.accountId}:${event.data.userId}`,
        outcomeCode: "onboarding.completed",
        sourceContext: "identity",
        subjectAccountId: event.data.accountId,
        subjectKind: "account",
        subjectEntityType: event.data.onboardingPath === "invitation" ? "invitation" : "account",
        subjectEntityId: event.data.invitationId ?? event.data.accountId,
        outcomeOccurredAt: event.timing.recordedAt,
        sourceEventId: event.id,
        performedByUserId: event.audit.performedByUserId,
        authenticationMethod: null,
        reasonCode: null,
      });
    },
  });
}
