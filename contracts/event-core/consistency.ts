import { AsyncLocalStorage } from "node:async_hooks";
import type { StoredEvent } from "./storage";

export type EventCommitMetadata = Readonly<{
  eventIds: readonly string[];
  maxGlobalPosition?: string;
}>;

type EventCommitMetadataStore = {
  eventIds: string[];
  maxGlobalPosition?: string;
};

const storage = new AsyncLocalStorage<EventCommitMetadataStore>();

export function runWithEventCommitMetadata<T>(action: () => T): T {
  return storage.run({ eventIds: [] }, action);
}

export function recordCommittedEvents(events: readonly StoredEvent[]): void {
  const store = storage.getStore();
  if (!store || events.length === 0) {
    return;
  }

  for (const event of events) {
    store.eventIds.push(String(event.eventId));
    const globalPosition = String(event.globalPosition);
    if (
      !store.maxGlobalPosition ||
      BigInt(globalPosition) > BigInt(store.maxGlobalPosition)
    ) {
      store.maxGlobalPosition = globalPosition;
    }
  }
}

export function getEventCommitMetadata(): EventCommitMetadata {
  const store = storage.getStore();
  if (!store) {
    return { eventIds: [] };
  }

  return {
    eventIds: [...store.eventIds],
    maxGlobalPosition: store.maxGlobalPosition,
  };
}
