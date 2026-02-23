// contracts/events/core.ts
import type { JsonObject } from "../primatives/json";
import type {
  AccountId,
  CommandId,
  CorrelationId,
  EventId,
  OrganizationId,
  TenantId,
} from "../primatives/ids";
import { IsoUtcTimestamp } from "../primatives/iso-timestamp";

export type EventType = `${string}.${string}.${string}.v${bigint}`;

export type RegistryShape = Record<
  EventType,
  { aggregateId: unknown; data: JsonObject }
>;

export type AllowedEventType<R extends RegistryShape> = keyof R;

export type AggregateIdFor<
  R extends RegistryShape,
  T extends AllowedEventType<R> & keyof R,
> = R[T] extends { aggregateId: infer A } ? A : never;

export type DataFor<
  R extends RegistryShape,
  T extends AllowedEventType<R> & keyof R,
> = R[T] extends { data: infer D } ? D : never;

export type InferAggregate<T extends EventType> =
  T extends `${string}.${infer A}.${string}.v${bigint}` ? A : never;

export type AggregateKey<TType, TId> = Readonly<{ type: TType; id: TId }>;

export type DomainEvent<
  R extends RegistryShape,
  T extends AllowedEventType<R>,
> = Readonly<{
  id: EventId;
  type: T;
  aggregate: AggregateKey<InferAggregate<T & EventType>, AggregateIdFor<R, T>>;
  data: DataFor<R, T>;
}>;

// metadata types (same as your latest)
export type DefaultDomainEventMetadata = Readonly<{
  tenant: Readonly<{ tenantId: TenantId }>;
  position: Readonly<{ stream: number; global?: string }>;
  producer: Readonly<{ service: string; instanceId?: string }>;
  trace: Readonly<{ traceparent: string; tracestate?: string }>;
  audit: Readonly<{
    performedByAccountId: AccountId;
    performedByOrganizationId: OrganizationId;
    onBehalfOfAccountId?: AccountId;
    onBehalfOfOrganizationId?: OrganizationId;
  }>;
  causality: Readonly<{
    correlationId: CorrelationId;
    causation:
      | { kind: "command"; commandId: CommandId }
      | { kind: "event"; eventId: EventId };
  }>;
  timing: Readonly<{
    occurredAt: IsoUtcTimestamp;
    recordedAt: IsoUtcTimestamp;
  }>;
}>;

export type DomainEventEnvelope<
  R extends RegistryShape,
  T extends AllowedEventType<R>,
  M extends DefaultDomainEventMetadata = DefaultDomainEventMetadata,
> = Readonly<{
  event: DomainEvent<R, T>;
  metadata: M;
}>;

export type EventHandler<
  R extends RegistryShape,
  T extends AllowedEventType<R>,
  M extends DefaultDomainEventMetadata = DefaultDomainEventMetadata,
> = (envelope: DomainEventEnvelope<R, T, M>) => Promise<void>;

export type EventHandlerMap<R extends RegistryShape> = {
  [T in AllowedEventType<R>]?: EventHandler<R, T>;
};
