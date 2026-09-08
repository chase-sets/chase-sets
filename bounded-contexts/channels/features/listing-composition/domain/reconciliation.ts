import type { AggregateEvolver, DomainEvent } from "@chase-sets/event-core";

export type ChannelListingReconciliationScope = "connection" | "account" | "catalog-item" | "inventory-item";

export type ChannelListingReconciliationRunEnqueuedEvent = DomainEvent<
  "channels.channel-listing-reconciliation.run-enqueued",
  Readonly<{ runId: string; connectionId: string; scope: ChannelListingReconciliationScope; scopeKey: string }>
>;
export type ChannelListingReconciliationChunkDrainedEvent = DomainEvent<
  "channels.channel-listing-reconciliation.chunk-drained",
  Readonly<{
    runId: string;
    fromCursor: string | null;
    toCursor: string | null;
    processedCount: number;
    remaining: boolean;
  }>
>;
export type ChannelListingReconciliationRunSettledEvent = DomainEvent<
  "channels.channel-listing-reconciliation.run-settled",
  Readonly<{
    runId: string;
    outcome: Readonly<{ kind: "complete"; processedCount: number }> | Readonly<{ kind: "failed"; code: string }>;
  }>
>;
export type ChannelListingReconciliationEvent =
  | ChannelListingReconciliationRunEnqueuedEvent
  | ChannelListingReconciliationChunkDrainedEvent
  | ChannelListingReconciliationRunSettledEvent;

export type ChannelListingReconciliationState = Readonly<{
  runId: string | null;
  connectionId: string | null;
  scope: ChannelListingReconciliationScope | null;
  scopeKey: string | null;
  cursor: string | null;
  restartRequired: boolean;
  processedCount: number;
  state: "empty" | "pending" | "draining" | "complete" | "failed";
}>;

export const initialChannelListingReconciliationState: ChannelListingReconciliationState = {
  runId: null,
  connectionId: null,
  scope: null,
  scopeKey: null,
  cursor: null,
  restartRequired: false,
  processedCount: 0,
  state: "empty",
};

export const evolveChannelListingReconciliation: AggregateEvolver<
  ChannelListingReconciliationState,
  ChannelListingReconciliationEvent
> = (state, event) => {
  switch (event.type) {
    case "channels.channel-listing-reconciliation.run-enqueued":
      if (state.runId !== null) return { ...state, restartRequired: true };
      return {
        runId: event.data.runId,
        connectionId: event.data.connectionId,
        scope: event.data.scope,
        scopeKey: event.data.scopeKey,
        cursor: null,
        restartRequired: false,
        processedCount: 0,
        state: "pending",
      };
    case "channels.channel-listing-reconciliation.chunk-drained":
      if (event.data.toCursor === null && event.data.processedCount === 0) {
        return { ...state, cursor: null, restartRequired: false, processedCount: 0, state: "draining" };
      }
      return {
        ...state,
        cursor: event.data.toCursor,
        processedCount: state.processedCount + event.data.processedCount,
        state: "draining",
      };
    case "channels.channel-listing-reconciliation.run-settled":
      return { ...state, state: event.data.outcome.kind, restartRequired: false };
  }
};
