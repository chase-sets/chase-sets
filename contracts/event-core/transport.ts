import type { IsoUtcTimestamp } from "../primitives/iso-utc-timestamp";
import type { JsonObject } from "../primitives/json";
import type {
  AccountId,
  CausationId,
  CommandId,
  CorrelationId,
  EventId,
  TenantId,
  UserId,
} from "../primitives/typed-ids";
import type {
  GlobalPosition,
  StoredEvent,
  StreamId,
  StreamVersion,
} from "./storage";

export type TransportEvent = Readonly<{
  id: EventId;
  type: string;
  streamId: StreamId;
  streamVersion: StreamVersion;
  globalPosition: GlobalPosition;
  tenantId: TenantId;
  data: JsonObject;
  metadata: JsonObject;
  audit: Readonly<{
    performedByUserId: UserId;
    forAccountId: AccountId;
  }>;
  trace: Readonly<{
    correlationId?: CorrelationId;
    causationId?: CausationId;
    commandId?: CommandId;
  }>;
  timing: Readonly<{
    occurredAt: IsoUtcTimestamp;
    recordedAt: IsoUtcTimestamp;
  }>;
}>;

export function toTransportEvent(event: StoredEvent): TransportEvent {
  return {
    id: event.eventId,
    type: event.eventType,
    streamId: event.streamId,
    streamVersion: event.streamVersion,
    globalPosition: event.globalPosition,
    tenantId: event.tenantId,
    data: event.payload,
    metadata: event.metadata,
    audit: {
      performedByUserId: event.performedByUserId,
      forAccountId: event.forAccountId,
    },
    trace: {
      correlationId: event.correlationId,
      causationId: event.causationId,
      commandId: event.commandId,
    },
    timing: {
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
    },
  };
}
