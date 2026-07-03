import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { ApiKeyId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  normalizeLabel,
  type ApiKeyStatus,
  type EmptyEventData,
} from "../../../support/runtime-support/common";

export type ApiKeyState = Readonly<{
  id: ApiKeyId | null;
  userId: UserId | null;
  name: string;
  keyPrefix: string | null;
  status: ApiKeyStatus;
  lastUsedAt: string | null;
}>;

export const initialApiKeyState: ApiKeyState = {
  id: null,
  userId: null,
  name: "",
  keyPrefix: null,
  status: "active",
  lastUsedAt: null,
};

export type CreateApiKeyCommand = Readonly<{
  type: "CreateApiKey";
  apiKeyId: ApiKeyId;
  userId: UserId;
  name: string;
  keyPrefix: string;
}>;

export type RotateApiKeyCommand = Readonly<{
  type: "RotateApiKey";
  keyPrefix: string;
}>;

export type RevokeApiKeyCommand = Readonly<{ type: "RevokeApiKey" }>;
export type RecordApiKeyUseCommand = Readonly<{
  type: "RecordApiKeyUse";
  usedAt: string;
}>;

export type ApiKeyCommand = CreateApiKeyCommand | RotateApiKeyCommand | RevokeApiKeyCommand | RecordApiKeyUseCommand;

export type ApiKeyCreatedEvent = DomainEvent<
  "identity.api-key.created",
  Readonly<{
    apiKeyId: ApiKeyId;
    userId: UserId;
    name: string;
    keyPrefix: string;
  }>
>;

export type ApiKeyRotatedEvent = DomainEvent<"identity.api-key.rotated", Readonly<{ keyPrefix: string }>>;

export type ApiKeyRevokedEvent = DomainEvent<"identity.api-key.revoked", EmptyEventData>;

export type ApiKeyUsedEvent = DomainEvent<"identity.api-key.used", Readonly<{ usedAt: string }>>;

export type ApiKeyEvent = ApiKeyCreatedEvent | ApiKeyRotatedEvent | ApiKeyRevokedEvent | ApiKeyUsedEvent;

export const decideApiKey: AggregateDecider<ApiKeyState, ApiKeyCommand, ApiKeyEvent> = (state, command) => {
  switch (command.type) {
    case "CreateApiKey":
      assert(state.id === null, "API key has already been created.");
      return [
        {
          type: "identity.api-key.created",
          data: {
            apiKeyId: command.apiKeyId,
            userId: command.userId,
            name: normalizeLabel(command.name),
            keyPrefix: command.keyPrefix,
          },
        },
      ];
    case "RotateApiKey":
      requireActiveApiKey(state);
      return [
        {
          type: "identity.api-key.rotated",
          data: { keyPrefix: command.keyPrefix },
        },
      ];
    case "RevokeApiKey":
      requireActiveApiKey(state);
      return [{ type: "identity.api-key.revoked", data: EMPTY_EVENT_DATA }];
    case "RecordApiKeyUse":
      requireActiveApiKey(state);
      return [
        {
          type: "identity.api-key.used",
          data: { usedAt: command.usedAt },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveApiKey: AggregateEvolver<ApiKeyState, ApiKeyEvent> = (state, event) => {
  switch (event.type) {
    case "identity.api-key.created":
      return {
        id: event.data.apiKeyId,
        userId: event.data.userId,
        name: event.data.name,
        keyPrefix: event.data.keyPrefix,
        status: "active",
        lastUsedAt: null,
      };
    case "identity.api-key.rotated":
      return { ...state, keyPrefix: event.data.keyPrefix };
    case "identity.api-key.revoked":
      return { ...state, status: "revoked" };
    case "identity.api-key.used":
      return { ...state, lastUsedAt: event.data.usedAt };
    default:
      return assertNever(event);
  }
};

function requireCreatedApiKey(state: ApiKeyState) {
  assert(state.id !== null, "API key must be created first.");
}

function requireActiveApiKey(state: ApiKeyState) {
  requireCreatedApiKey(state);
  assert(state.status === "active", "Only active API keys can change.");
}
