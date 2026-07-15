import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CsatResponseRedactedEvent } from "../../../csat/domain/invitation";

type ProtectFromResponseRedaction = (
  input: Readonly<{
    invitationId: string;
    scope: "response-content" | "direct-identifiers" | "all-sensitive";
    reason: string;
    actorId: string;
    actedAt: string;
  }>,
  context: EventStoreContext,
) => Promise<unknown>;

export function buildFeedbackCaseRedactionReactionHandlers(protect: ProtectFromResponseRedaction): ProjectorHandlerMap {
  return {
    "customer-feedback.response.redacted": async (event) => {
      const redaction = event.data as CsatResponseRedactedEvent["data"];
      await protect(
        {
          invitationId: redaction.invitationId,
          scope: redaction.scope,
          reason: redaction.reason,
          actorId: redaction.actorId,
          actedAt: redaction.redactedAt,
        },
        { tenantId: event.tenantId, audit: event.audit, trace: event.trace },
      );
    },
  };
}
