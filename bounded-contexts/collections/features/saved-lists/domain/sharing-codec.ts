import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import type { JsonObject } from "@chase-sets/primitives/json";
import { savedListSharingEventSchemaVersion } from "./sharing-contracts";
import { savedListSharingEventTypes, type SavedListSharingEvent } from "./sharing-domain";

export function createSavedListSharingEventCodec(): DomainEventCodec<SavedListSharingEvent> {
  return {
    encode: (event) => ({ eventType: event.type, payload: event.data as JsonObject }),
    decode: (stored) => {
      if (!savedListSharingEventTypes.includes(stored.eventType as SavedListSharingEvent["type"])) {
        throw new Error(`Unrecognized Saved List sharing event type '${stored.eventType}'.`);
      }
      const version = stored.payload.eventSchemaVersion ?? 1;
      if (version !== savedListSharingEventSchemaVersion) {
        throw new Error(`Unsupported Saved List sharing event schema version '${String(version)}'.`);
      }
      return {
        type: stored.eventType,
        data: { ...stored.payload, eventSchemaVersion: savedListSharingEventSchemaVersion },
      } as SavedListSharingEvent;
    },
  };
}
