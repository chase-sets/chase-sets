import type { IsoUtcTimestamp } from "../primitives/iso-utc-timestamp";

/**
 * A persisted fold-state snapshot for one aggregate stream.
 *
 * Snapshots are a pure LOAD-TIME CACHE, never a source of truth: the event
 * stream stays canonical, and a snapshot store must always be safe to
 * delete or fully rebuild from events with no data loss. `schemaVersion`
 * lets `createAggregateRepository` (see `aggregate-repository-internal.ts`)
 * detect a stale snapshot after an `evolve` fold shape change and fall back
 * to full replay instead of misapplying it.
 */
export type StoredAggregateSnapshot<State> = Readonly<{
  streamId: string;
  streamVersion: number;
  schemaVersion: number;
  state: State;
  updatedAt: IsoUtcTimestamp;
}>;

export type AggregateSnapshotToStore<State> = Readonly<{
  streamId: string;
  streamVersion: number;
  schemaVersion: number;
  state: State;
}>;

export type AggregateSnapshotStore<State = unknown> = Readonly<{
  /**
   * Returns the latest snapshot for a stream, or `null` if none exists.
   * Callers treat a thrown error the same as a missing snapshot -- a
   * corrupt or unreachable snapshot store must fall back to full replay,
   * never fail the load.
   */
  loadLatest: (streamId: string) => Promise<StoredAggregateSnapshot<State> | null>;
  /**
   * Persists (or replaces) the latest snapshot for a stream. Implementations
   * must be safe to call concurrently for the same stream and must never let
   * a superseded write regress a newer stored snapshot to an older
   * `streamVersion` -- "last write loses" is exactly as safe as "last write
   * wins" here, since the event stream is unaffected either way.
   */
  save: (snapshot: AggregateSnapshotToStore<State>) => Promise<void>;
}>;
