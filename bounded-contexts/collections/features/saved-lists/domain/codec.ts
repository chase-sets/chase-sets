import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import type { JsonObject } from "@chase-sets/primitives/json";
import { savedListEventSchemaVersion, type SavedListEventSchemaVersion } from "./contracts";
import { savedListEventTypes, type SavedListEvent } from "./domain";

export type StoredSavedListEvent = Readonly<{
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export function upcastSavedListEvent(stored: StoredSavedListEvent): SavedListEvent {
  if (!savedListEventTypes.includes(stored.eventType as SavedListEvent["type"])) {
    throw new Error(`Unrecognized Saved List event type '${stored.eventType}'.`);
  }

  const rawVersion = stored.payload.eventSchemaVersion;
  const version = rawVersion === undefined ? 1 : rawVersion;
  if (version !== savedListEventSchemaVersion) {
    throw new Error(`Unsupported Saved List event schema version '${String(version)}'.`);
  }

  return {
    type: stored.eventType,
    data: {
      ...stored.payload,
      eventSchemaVersion: savedListEventSchemaVersion as SavedListEventSchemaVersion,
    },
  } as SavedListEvent;
}

export function createSavedListEventCodec(): DomainEventCodec<SavedListEvent> {
  return {
    encode: (event) => ({ eventType: event.type, payload: event.data as JsonObject }),
    decode: (stored) => upcastSavedListEvent({ eventType: stored.eventType, payload: stored.payload }),
  };
}
