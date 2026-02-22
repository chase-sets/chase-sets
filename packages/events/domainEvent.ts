import {
  AccountId,
  CommandId,
  CorrelationId,
  EventId,
  OrganizationId,
} from "../primatives/ids";

/**
 * ISO-8601 UTC timestamp string.
 */
export type IsoUtcTimestamp = string;

/**
 * Represents the context of an aggregate, including its type and unique identifier.
 *
 * @template TType - The type name of the aggregate.
 * @template TId - The type of the aggregate's unique identifier.
 */
export type AggregateContext<TType extends string, TId> = {
  type: TType;
  id: TId;
};

/**
 * Represents a domain event, which captures a significant occurrence within the domain.
 *
 * Domain events are append-only immutable facts. The `version` is the optimistic concurrency
 * counter for a single aggregate stream.
 *
 * @template TAggregateType - The aggregate type name.
 * @template TId - The type of the aggregate's unique identifier.
 * @template TData - The type of the event's data payload.
 */
export type DomainEvent<TAggregateType extends string, TId, TData> = {
  id: EventId;
  type: string;
  aggregate: AggregateContext<TAggregateType, TId>;
  version: number;
  occurredAt: IsoUtcTimestamp;
  performedByAccountId: AccountId;
  forOrganizationId: OrganizationId;
  commandId?: CommandId;
  correlationId?: CorrelationId;
  data: TData;
};
