import type { AggregateDecider, AggregateEvolver, AggregateRepository, DomainEvent } from "@chase-sets/event-core";
import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import type {
  AppendToStreamsIndependentResult,
  AppendToStreamsIndependentlyTelemetry,
  EventStore,
} from "@chase-sets/event-core/event-store";
import type {
  AppendToStreamInput,
  EventStoreContext,
  ExpectedStreamVersion,
  StoredEvent,
} from "@chase-sets/event-core/storage";

/**
 * The bulk append lane: the reusable "chunked multi-listing appends + lane
 * fairness" primitive for the m113 (repricing at scale) throughput lane. It
 * is deliberately generic over any event-sourced aggregate -- marketplace
 * listings wire their UpdateListingPrice decider through it today (see
 * `bounded-contexts/marketplace/features/listings/api/runtime.ts`'s
 * `applyBulkListingPriceUpdates`); the future bulk-ingestion on-ramp and the
 * policy evaluation engine are both meant to funnel through the SAME lane
 * rather than re-implement chunking.
 *
 * What it does, per call:
 *  1. Loads current state + version and runs `decide` for every item,
 *     independently and in parallel (a decide-time throw or a suppressed
 *     no-op command only affects that one item -- see `prepareBulkAppendItem`).
 *  2. Groups the items that produced events into chunks of at most
 *     `chunkSize` streams.
 *  3. Appends each chunk in ONE transaction via
 *     `eventStore.appendToStreamsIndependently` -- one advisory-lock
 *     acquisition window, one multi-row event INSERT, per chunk. A version
 *     conflict on one stream in the chunk never rolls back its siblings.
 *  4. Yields between chunks (`yieldIntervalMs`, floor of one event-loop
 *     tick) so a long bulk run cannot reacquire the store-wide advisory
 *     lock back-to-back and starve interactive appends.
 *
 * Chunk size and yield interval are caller-supplied (resolved from m110
 * platform-policy by the caller) rather than compiled in here -- this
 * module has no context ownership of the business dial, only the mechanism.
 */

export type BulkAppendLaneItem<Command> = Readonly<{
  streamId: string;
  command: Command;
  context: EventStoreContext;
  /** Optional caller-observed version for manual-edit-wins workflows. */
  expectedVersion?: ExpectedStreamVersion;
  /** Stable mutation identity; encoded events receive deterministic ids for retry-safe appends. */
  eventIdPrefix?: string;
}>;

export type BulkAppendLaneOutcome<Event extends DomainEvent> = Readonly<{
  streamId: string;
  /**
   * - "applied": new events were committed for this stream.
   * - "no_op": `decide` returned zero events (e.g. domain-level suppression of a repeated,
   *   identical price) -- nothing to append.
   * - "conflict": the stream's version moved between load and append; safe to reload and retry.
   * - "error": loading state or running `decide` threw (e.g. a domain invariant like "withdrawn
   *   listings cannot be updated"). Isolated to this item; every other item in the batch is unaffected.
   */
  outcome: "applied" | "no_op" | "conflict" | "error";
  version: number;
  newEvents: readonly Event[];
  storedEvents: readonly StoredEvent[];
  error?: Error;
}>;

export type BulkAppendLane<Command, Event extends DomainEvent> = (
  items: readonly BulkAppendLaneItem<Command>[],
) => Promise<readonly BulkAppendLaneOutcome<Event>[]>;

export type BulkAppendLaneConfig<State, Command, Event extends DomainEvent> = Readonly<{
  eventStore: EventStore;
  repository: AggregateRepository<State, Event>;
  codec: DomainEventCodec<Event>;
  evolve: AggregateEvolver<State, Event>;
  decide: AggregateDecider<State, Command, Event>;
  /** Maximum streams appended in one transaction/advisory-lock window. */
  chunkSize: number;
  /** Milliseconds to yield between chunks; 0 still yields one event-loop tick. */
  yieldIntervalMs: number;
  telemetry?: AppendToStreamsIndependentlyTelemetry;
  /** Test seam: replace the between-chunk yield with a spy/no-op. */
  sleep?: (ms: number) => Promise<void>;
}>;

export function createBulkAppendLane<State, Command, Event extends DomainEvent>(
  config: BulkAppendLaneConfig<State, Command, Event>,
): BulkAppendLane<Command, Event> {
  if (!Number.isInteger(config.chunkSize) || config.chunkSize < 1) {
    throw new Error("Bulk append lane chunk size must be a positive integer.");
  }
  if (!Number.isFinite(config.yieldIntervalMs) || config.yieldIntervalMs < 0) {
    throw new Error("Bulk append lane yield interval must be zero or a positive number of milliseconds.");
  }

  const appendIndependently = config.eventStore.appendToStreamsIndependently;
  if (!appendIndependently) {
    throw new Error("Bulk append lane requires an event store that supports appendToStreamsIndependently.");
  }

  const sleep = config.sleep ?? defaultLaneYield;

  return async (items) => {
    const chunks = chunkItems(items, config.chunkSize);
    const outcomes: BulkAppendLaneOutcome<Event>[] = [];

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex]!;
      const prepared = await Promise.all(chunk.map((item) => prepareBulkAppendItem(config, item)));
      const appendable = prepared.filter(isAppendablePreparedItem);

      let resultsByStreamId = new Map<string, AppendToStreamsIndependentResult>();
      if (appendable.length > 0) {
        const results = await appendIndependently(
          appendable.map((entry) => entry.appendInput),
          config.telemetry ? { telemetry: config.telemetry } : undefined,
        );
        resultsByStreamId = new Map(results.map((result) => [result.streamId, result] as const));
      }

      for (const entry of prepared) {
        outcomes.push(resolveBulkAppendOutcome(entry, resultsByStreamId));
      }

      const isLastChunk = chunkIndex === chunks.length - 1;
      if (!isLastChunk) {
        await sleep(config.yieldIntervalMs);
      }
    }

    return outcomes;
  };
}

type PreparedAppendableItem<Event extends DomainEvent> = Readonly<{
  kind: "append";
  streamId: string;
  version: number;
  newEvents: readonly Event[];
  appendInput: AppendToStreamInput;
}>;

type PreparedNoOpItem = Readonly<{ kind: "no_op"; streamId: string; version: number }>;

type PreparedErrorItem = Readonly<{ kind: "error"; streamId: string; version: number; error: Error }>;

type PreparedBulkAppendItem<Event extends DomainEvent> =
  | PreparedAppendableItem<Event>
  | PreparedNoOpItem
  | PreparedErrorItem;

function isAppendablePreparedItem<Event extends DomainEvent>(
  entry: PreparedBulkAppendItem<Event>,
): entry is PreparedAppendableItem<Event> {
  return entry.kind === "append";
}

async function prepareBulkAppendItem<State, Command, Event extends DomainEvent>(
  config: BulkAppendLaneConfig<State, Command, Event>,
  item: BulkAppendLaneItem<Command>,
): Promise<PreparedBulkAppendItem<Event>> {
  try {
    const loaded = await config.repository.load(item.streamId);
    const newEvents = config.decide(loaded.state, item.command);

    if (newEvents.length === 0) {
      return { kind: "no_op", streamId: item.streamId, version: loaded.version };
    }

    const events = newEvents.map((event, index) => {
      const encoded = config.codec.encode(event);
      return item.eventIdPrefix
        ? { ...encoded, eventId: `${item.eventIdPrefix}:${index}` as NonNullable<typeof encoded.eventId> }
        : encoded;
    });

    return {
      kind: "append",
      streamId: item.streamId,
      version: loaded.version,
      newEvents,
      appendInput: {
        streamId: item.streamId,
        expectedVersion: item.expectedVersion ?? loaded.version,
        events,
        context: item.context,
      },
    };
  } catch (error) {
    return {
      kind: "error",
      streamId: item.streamId,
      version: 0,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function resolveBulkAppendOutcome<Event extends DomainEvent>(
  entry: PreparedBulkAppendItem<Event>,
  resultsByStreamId: ReadonlyMap<string, AppendToStreamsIndependentResult>,
): BulkAppendLaneOutcome<Event> {
  if (entry.kind === "no_op") {
    return { streamId: entry.streamId, outcome: "no_op", version: entry.version, newEvents: [], storedEvents: [] };
  }

  if (entry.kind === "error") {
    return {
      streamId: entry.streamId,
      outcome: "error",
      version: entry.version,
      newEvents: [],
      storedEvents: [],
      error: entry.error,
    };
  }

  const result = resultsByStreamId.get(entry.streamId);
  if (!result || result.outcome === "conflict") {
    return {
      streamId: entry.streamId,
      outcome: "conflict",
      version: entry.version,
      newEvents: entry.newEvents,
      storedEvents: [],
      ...(result?.error ? { error: result.error } : {}),
    };
  }

  const storedEvents = result.storedEvents;
  const version =
    storedEvents.length > 0
      ? storedEvents.reduce((currentVersion, event) => Math.max(currentVersion, event.streamVersion), entry.version)
      : entry.version;

  return {
    streamId: entry.streamId,
    outcome: "applied",
    version,
    newEvents: entry.newEvents,
    storedEvents,
  };
}

/** Exported for callers that need to pre-split work into the same chunk boundaries this lane uses internally (see `defaultLaneYield`'s doc comment). */
export function chunkItems<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  if (items.length === 0) {
    return [];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * The lane's between-chunk yield, exported so callers that split their own
 * work into lane-sized waves around this lane (e.g. marketplace's
 * `applyBulkListingPriceUpdates`, which revalidates a per-account terms
 * session between chunks as part of the m113 repricing-at-scale throughput
 * lane) can reuse the exact same yield semantics for their own inter-wave
 * pause instead of re-implementing it.
 */
export function defaultLaneYield(ms: number): Promise<void> {
  if (ms <= 0) {
    return new Promise((resolve) => setImmediate(resolve));
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
