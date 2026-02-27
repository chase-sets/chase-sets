import type { IsoUtcTimestamp } from "../primitives/iso-utc-timestamp";
import type { JsonObject } from "../primitives/json";
import type {
  AccountId,
  CausationId,
  CommandId,
  CorrelationId,
  EventId,
  OrganizationId,
  TenantId,
} from "../primitives/typed-ids";

export type StreamId = string;

export type StreamVersion = number;

export type GlobalPosition = number;

export type ExpectedStreamVersion = StreamVersion | "any" | "no_stream";

export type EventAuditContext = Readonly<{
  performedByAccountId: AccountId;
  forOrganizationId: OrganizationId;
}>;

export type EventTraceContext = Readonly<{
  correlationId?: CorrelationId;
  causationId?: CausationId;
  commandId?: CommandId;
}>;

export type EventStoreContext = Readonly<{
  tenantId: TenantId;
  audit: EventAuditContext;
  trace?: EventTraceContext;
}>;

export type EventRecordToStore = Readonly<{
  eventType: string;
  payload: JsonObject;
  metadata?: JsonObject;
  occurredAt?: IsoUtcTimestamp;
}>;

export type StoredEvent<
  EventType extends string = string,
  Payload extends JsonObject = JsonObject,
  Metadata extends JsonObject = JsonObject,
> = Readonly<{
  eventId: EventId;
  streamId: StreamId;
  streamVersion: StreamVersion;
  globalPosition: GlobalPosition;
  tenantId: TenantId;
  eventType: EventType;
  payload: Payload;
  metadata: Metadata;
  occurredAt: IsoUtcTimestamp;
  recordedAt: IsoUtcTimestamp;
  performedByAccountId: AccountId;
  forOrganizationId: OrganizationId;
  correlationId?: CorrelationId;
  causationId?: CausationId;
  commandId?: CommandId;
}>;

export type AppendToStreamInput = Readonly<{
  streamId: StreamId;
  expectedVersion: ExpectedStreamVersion;
  events: readonly EventRecordToStore[];
  context: EventStoreContext;
}>;

export type ReadStreamInput = Readonly<{
  streamId: StreamId;
  fromVersion?: StreamVersion;
  limit?: number;
}>;

export type ReadAllInput = Readonly<{
  afterGlobalPosition?: GlobalPosition;
  tenantId?: TenantId;
  limit?: number;
}>;
