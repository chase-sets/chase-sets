import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { ChannelConnectionError, type ChannelConnectionEvent } from "./contracts";
import {
  assertBindingsShape,
  assertChannelEnvironment,
  assertClosedRecord,
  assertCredentialReference,
  assertOpaqueId,
  assertProviderKey,
  assertRfc3339Instant,
} from "./validation";

export const channelConnectionEventCodec: DomainEventCodec<ChannelConnectionEvent> = {
  encode: (event) => ({ eventType: event.type, payload: event.data }),
  decode: (stored) => decodeChannelConnectionEvent(stored),
};

function decodeChannelConnectionEvent(stored: Pick<StoredEvent, "eventType" | "payload">): ChannelConnectionEvent {
  switch (stored.eventType) {
    case "channels.connection.connected": {
      assertClosedRecord(
        stored.payload,
        ["connectionId", "accountId", "providerKey", "environment", "createdAt"],
        "connected event",
      );
      assertOpaqueId(stored.payload.connectionId, "connectionId");
      assertOpaqueId(stored.payload.accountId, "accountId");
      assertProviderKey(stored.payload.providerKey);
      const environment = stored.payload.environment;
      assertChannelEnvironment(environment);
      assertRfc3339Instant(stored.payload.createdAt, "createdAt");
      return {
        type: stored.eventType,
        data: {
          connectionId: stored.payload.connectionId,
          accountId: stored.payload.accountId,
          providerKey: stored.payload.providerKey,
          environment,
          createdAt: stored.payload.createdAt,
        },
      };
    }
    case "channels.connection.activated": {
      assertClosedRecord(stored.payload, ["connectionId", "credentialReference", "bindings"], "activated event");
      assertOpaqueId(stored.payload.connectionId, "connectionId");
      if (stored.payload.credentialReference !== null) assertCredentialReference(stored.payload.credentialReference);
      assertBindingsShape(stored.payload.bindings);
      if (stored.payload.bindings.length === 0) invalidEvent("bindings");
      return {
        type: stored.eventType,
        data: {
          connectionId: stored.payload.connectionId,
          credentialReference: stored.payload.credentialReference,
          bindings: stored.payload.bindings,
        },
      };
    }
    case "channels.connection.paused":
    case "channels.connection.resumed":
    case "channels.connection.disconnected": {
      assertClosedRecord(stored.payload, ["connectionId"], `${stored.eventType} event`);
      assertOpaqueId(stored.payload.connectionId, "connectionId");
      return { type: stored.eventType, data: { connectionId: stored.payload.connectionId } };
    }
    default:
      throw new ChannelConnectionError("invalid-input", "Unsupported Channel Connection event type.");
  }
}

function invalidEvent(field: string): never {
  throw new ChannelConnectionError("invalid-input", `Channel Connection event ${field} is invalid.`);
}
