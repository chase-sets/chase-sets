import {
  readRealtimePatches,
  type ReadRealtimePatchesOptions,
  type RealtimeContextStore,
  type RealtimeCursor,
} from "./realtime-outbox-store";

export type RealtimeReadBatch = Awaited<ReturnType<typeof readRealtimePatches>>;

export type RealtimeReadHub = Readonly<{
  read: (
    stores: readonly RealtimeContextStore[],
    topics: readonly string[],
    cursor: RealtimeCursor,
    batchSize: number,
    options?: ReadRealtimePatchesOptions,
  ) => Promise<RealtimeReadBatch>;
}>;

export type RealtimeReadHubObserver = Readonly<{
  readStarted?: (event: RealtimeReadHubEvent) => void;
  readCoalesced?: (event: RealtimeReadHubEvent) => void;
}>;

export type RealtimeReadHubEvent = Readonly<{
  storeNames: readonly string[];
  topics: readonly string[];
  batchSize: number;
}>;

export function createRealtimeReadHub(
  options: Readonly<{
    observer?: RealtimeReadHubObserver;
  }> = {},
): RealtimeReadHub {
  const inFlightReads = new Map<string, Promise<RealtimeReadBatch>>();

  return {
    read: (stores, topics, cursor, batchSize, readOptions = {}) => {
      const key = JSON.stringify({
        stores: stores.map((store) => store.contextName).sort(),
        topics: [...topics].sort(),
        cursor,
        batchSize,
        pruneExpired: readOptions.pruneExpired ?? true,
        includeTopicLag: readOptions.includeTopicLag ?? false,
        compactSummaries: readOptions.compactSummaries ?? true,
      });
      const existing = inFlightReads.get(key);
      if (existing) {
        options.observer?.readCoalesced?.({
          storeNames: stores.map((store) => store.contextName),
          topics,
          batchSize,
        });
        return existing;
      }

      options.observer?.readStarted?.({
        storeNames: stores.map((store) => store.contextName),
        topics,
        batchSize,
      });
      const read = readRealtimePatches(stores, topics, cursor, batchSize, readOptions).finally(() => {
        inFlightReads.delete(key);
      });
      inFlightReads.set(key, read);
      return read;
    },
  };
}
