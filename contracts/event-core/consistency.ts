import { AsyncLocalStorage } from "node:async_hooks";
import type { StoredEvent } from "./storage";

export type EventCommitMetadata = Readonly<{
  eventIds: readonly string[];
  maxGlobalPosition?: string;
  sources: readonly EventCommitSourceMetadata[];
}>;

export type EventCommitSourceMetadata = Readonly<{
  sourceContextName: string;
  eventIds: readonly string[];
  maxGlobalPosition: string;
}>;

type EventCommitMetadataStore = {
  eventIds: string[];
  maxGlobalPosition?: string;
  sources: Map<string, { eventIds: string[]; maxGlobalPosition?: string }>;
};

const storage = new AsyncLocalStorage<EventCommitMetadataStore>();

export function runWithEventCommitMetadata<T>(action: () => T): T {
  return storage.run({ eventIds: [], sources: new Map() }, action);
}

export function recordCommittedEvents(events: readonly StoredEvent[], sourceContextNameOverride?: string): void {
  const store = storage.getStore();
  if (!store || events.length === 0) {
    return;
  }

  for (const event of events) {
    const eventId = String(event.eventId);
    store.eventIds.push(eventId);
    const globalPosition = String(event.globalPosition);
    if (!store.maxGlobalPosition || BigInt(globalPosition) > BigInt(store.maxGlobalPosition)) {
      store.maxGlobalPosition = globalPosition;
    }

    const sourceContextName = sourceContextNameOverride ?? sourceContextNameFromStreamId(event.streamId);
    const source = store.sources.get(sourceContextName) ?? { eventIds: [] };
    source.eventIds.push(eventId);
    if (!source.maxGlobalPosition || BigInt(globalPosition) > BigInt(source.maxGlobalPosition)) {
      source.maxGlobalPosition = globalPosition;
    }
    store.sources.set(sourceContextName, source);
  }
}

export function getEventCommitMetadata(): EventCommitMetadata {
  const store = storage.getStore();
  if (!store) {
    return { eventIds: [], sources: [] };
  }

  return {
    eventIds: [...store.eventIds],
    maxGlobalPosition: store.maxGlobalPosition,
    sources: [...store.sources.entries()]
      .flatMap(([sourceContextName, source]) =>
        source.maxGlobalPosition
          ? [
              {
                sourceContextName,
                eventIds: [...source.eventIds],
                maxGlobalPosition: source.maxGlobalPosition,
              },
            ]
          : [],
      )
      .sort((left, right) => left.sourceContextName.localeCompare(right.sourceContextName)),
  };
}

function sourceContextNameFromStreamId(streamId: string): string {
  const separatorIndex = streamId.indexOf(".");
  return separatorIndex > 0 ? streamId.slice(0, separatorIndex) : streamId;
}
