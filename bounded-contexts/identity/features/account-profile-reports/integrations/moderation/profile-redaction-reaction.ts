import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { parsePlatformOperationsReportedContentActionRecordedPayload } from "@chase-sets/event-core/public-event-payloads";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { eligibilityScopeKeys, type IdentityMutationPersistence } from "../../../account-management/api/fences";
import {
  decideProfileDisplayNameRedaction,
  evolveAccount,
  initialAccountState,
  type AccountEvent,
} from "../../../accounts/domain/domain";

const codec = createPassthroughDomainEventCodec<AccountEvent>();

function latestDisplayNameChange(history: readonly StoredEvent[]): number {
  let name: unknown;
  let changedAt = Number.POSITIVE_INFINITY;
  for (const event of history) {
    if (event.eventType !== "identity.account.created" && event.eventType !== "identity.account.profile-updated")
      continue;
    if (event.payload.displayName === name) continue;
    name = event.payload.displayName;
    changedAt = Date.parse(event.recordedAt);
  }
  return changedAt;
}

export function buildProfileRedactionReactionHandlers(
  persistence: Pick<IdentityMutationPersistence, "transaction">,
): ProjectorHandlerMap {
  return {
    "platform-operations.reported-content.action-recorded": async (event) => {
      const action = parsePlatformOperationsReportedContentActionRecordedPayload(event.data);
      if (action.targetType !== "account-profile" || action.action !== "redact-profile-display-name") return;
      const { actionId, operatorUserId } = action;
      if (!operatorUserId || operatorUserId !== event.audit.performedByUserId) return;

      const { tenantId, audit, trace } = event;
      const streamId = `identity.account-${action.targetId}`;
      try {
        await persistence.transaction(eligibilityScopeKeys(tenantId, streamId, []), async (tx) => {
          const history = await tx.read(streamId);
          if (!history.length || history.some((stored) => stored.tenantId !== tenantId)) return;
          if (
            history.some(
              ({ eventType, payload }) =>
                eventType === "identity.account.display-name-redacted" && payload.actionId === actionId,
            )
          )
            return;
          const state = history.reduce(
            (current, stored) => evolveAccount(current, codec.decode(stored)),
            initialAccountState,
          );
          if (state.id !== action.targetId || state.status === "closed") return;
          // The databases have independent positions. Compare recorded time, and let the owner win ties.
          if (!(latestDisplayNameChange(history) < Date.parse(action.recordedAt))) return;
          await tx.append([
            {
              streamId,
              expectedVersion: history.length,
              context: { tenantId, audit, trace },
              events: decideProfileDisplayNameRedaction(state, { actionId, operatorUserId }).map(codec.encode),
            },
          ]);
        });
      } catch {
        throw new Error("profile_redaction_unavailable");
      }
    },
  };
}
