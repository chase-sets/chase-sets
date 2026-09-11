import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ChannelListingCompositionServices } from "../../listing-composition/api/runtime";
import type { ChannelListingDesiredStateChangedData } from "../../listing-composition/domain/contracts";
import type {
  OutboundOperationRecord,
  OutboundSyncRuntimeDependencies,
  OutboundSyncServices,
} from "../domain/contracts";

type DesiredStateEventPayloads = Readonly<{
  "channels.channel-listing.desired-state-changed": ChannelListingDesiredStateChangedData;
}>;

type SourceContextRow = Readonly<{
  tenant_id: string;
  performed_by_user_id: string;
  for_account_id: string;
}>;

export function buildChannelOutboundOperationReactionHandlers(services: OutboundSyncServices): ProjectorHandlerMap {
  return defineProjectorHandlers<DesiredStateEventPayloads>({
    "channels.channel-listing.desired-state-changed": async (event) => {
      const desired = event.data;
      await services.enqueueDesiredState({
        connectionId: desired.connectionId,
        channelListingId: desired.channelListingId,
        listingId: desired.listingId,
        operationKind: desired.intent,
        listingRevision: desired.listingRevision,
        desiredStateSequence: desired.desiredStateSequence,
        desiredStateHash: desired.desiredStateHash,
        payload:
          desired.intent === "delist"
            ? { kind: "delist", delist: desired.delist }
            : { kind: "draft", draft: desired.draft },
        envelope: {
          sourceEventId: String(event.id),
          sourceStreamId: event.streamId,
          sourceStreamVersion: event.streamVersion,
          sourceGlobalPosition: event.globalPosition,
          sourceOccurredAt: event.timing.occurredAt,
        },
      });
    },
  });
}

export function createChannelListingPublicationOutcomeRecorder(
  services: Pick<ChannelListingCompositionServices, "recordChannelListingPublicationOutcome">,
): NonNullable<OutboundSyncRuntimeDependencies["recordOutcome"]> {
  return async (db, operation, outcome) => {
    const context = await readSourceEventContext(db, operation);
    if (!context) return "link-write-refused";
    const result = await services.recordChannelListingPublicationOutcome(
      {
        connectionId: operation.connectionId,
        channelListingId: operation.channelListingId,
        operationId: operation.operationId,
        reportedDesiredStateSequence: operation.sourceDesiredStateSequence,
        reportedListingRevision: operation.listingRevision,
        reportedDesiredStateHash: operation.sourceDesiredStateHash,
        outcome,
        expectedStreamVersion: operation.sourceStreamVersion,
      },
      context,
    );
    return result.kind === "applied" || result.kind === "unchanged" ? "applied" : "link-write-refused";
  };
}

async function readSourceEventContext(
  db: PgQueryable,
  operation: OutboundOperationRecord,
): Promise<EventStoreContext | null> {
  const result = await db.query<SourceContextRow>(
    `SELECT source.tenant_id, source.performed_by_user_id, source.for_account_id
     FROM event_store_events AS source
     JOIN channel_connections AS connection
       ON connection.connection_id = $2
      AND connection.account_id = source.for_account_id
     WHERE source.event_id = $1
       AND source.stream_id = $3
       AND source.stream_version = $4
       AND source.global_position = $5`,
    [
      operation.sourceEventId,
      operation.connectionId,
      operation.sourceStreamId,
      operation.sourceStreamVersion,
      operation.sourceGlobalPosition,
    ],
  );
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) return null;
  return {
    tenantId: row.tenant_id as EventStoreContext["tenantId"],
    audit: {
      performedByUserId: row.performed_by_user_id as EventStoreContext["audit"]["performedByUserId"],
      forAccountId: row.for_account_id as EventStoreContext["audit"]["forAccountId"],
    },
  };
}
