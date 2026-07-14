import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { SavedListCommandId, SavedListId } from "./contracts";
import {
  privateSavedListSharingDisclosure,
  savedListSharingEventSchemaVersion,
  type SavedListSharingDisclosure,
  type SavedListSharingSnapshot,
} from "./sharing-contracts";

type VersionedSharingData<T extends Record<string, unknown>> = Readonly<
  T & {
    eventSchemaVersion: typeof savedListSharingEventSchemaVersion;
    commandId: SavedListCommandId;
    listId: SavedListId;
  }
>;

export type ConfigureSavedListSharingCommand = Readonly<{
  type: "ConfigureSavedListSharing";
  commandId: SavedListCommandId;
  listId: SavedListId;
  ownerAccountId: AccountId;
  configuredAt: string;
}>;
export type ChangeSavedListDisclosureCommand = Readonly<{
  type: "ChangeSavedListDisclosure";
  commandId: SavedListCommandId;
  disclosure: SavedListSharingDisclosure;
  changedAt: string;
}>;
export type RotateSavedListUnlistedAccessCommand = Readonly<{
  type: "RotateSavedListUnlistedAccess";
  commandId: SavedListCommandId;
  keyId: string;
  verifier: string;
  rotatedAt: string;
}>;
export type RevokeSavedListUnlistedAccessCommand = Readonly<{
  type: "RevokeSavedListUnlistedAccess";
  commandId: SavedListCommandId;
  revokedAt: string;
}>;
export type SavedListSharingCommand =
  | ConfigureSavedListSharingCommand
  | ChangeSavedListDisclosureCommand
  | RotateSavedListUnlistedAccessCommand
  | RevokeSavedListUnlistedAccessCommand;

export type SavedListSharingConfiguredEvent = DomainEvent<
  "collections.saved-list-sharing.configured",
  VersionedSharingData<{
    ownerAccountId: AccountId;
    disclosure: SavedListSharingDisclosure;
    configuredAt: string;
  }>
>;
export type SavedListDisclosureChangedEvent = DomainEvent<
  "collections.saved-list-sharing.disclosure-changed",
  VersionedSharingData<{ disclosure: SavedListSharingDisclosure; changedAt: string }>
>;
export type SavedListUnlistedAccessRotatedEvent = DomainEvent<
  "collections.saved-list-sharing.unlisted-access-rotated",
  VersionedSharingData<{
    generation: number;
    keyId: string;
    verifier: string;
    rotatedAt: string;
  }>
>;
export type SavedListUnlistedAccessRevokedEvent = DomainEvent<
  "collections.saved-list-sharing.unlisted-access-revoked",
  VersionedSharingData<{ generation: number; revokedAt: string }>
>;
export type SavedListSharingEvent =
  | SavedListSharingConfiguredEvent
  | SavedListDisclosureChangedEvent
  | SavedListUnlistedAccessRotatedEvent
  | SavedListUnlistedAccessRevokedEvent;
export type SavedListSharingEventPayloads = {
  [Event in SavedListSharingEvent as Event["type"]]: Event["data"];
};
export const savedListSharingEventTypes = [
  "collections.saved-list-sharing.configured",
  "collections.saved-list-sharing.disclosure-changed",
  "collections.saved-list-sharing.unlisted-access-rotated",
  "collections.saved-list-sharing.unlisted-access-revoked",
] as const satisfies readonly SavedListSharingEvent["type"][];

export type SavedListSharingState = Readonly<{
  identity: Readonly<{ listId: SavedListId; ownerAccountId: AccountId }> | null;
  disclosure: SavedListSharingDisclosure;
  unlistedAccess: Readonly<{
    generation: number;
    keyId: string | null;
    verifier: string | null;
    changedAt: string | null;
  }>;
  changedAt: string | null;
}>;
export const initialSavedListSharingState: SavedListSharingState = {
  identity: null,
  disclosure: privateSavedListSharingDisclosure,
  unlistedAccess: { generation: 0, keyId: null, verifier: null, changedAt: null },
  changedAt: null,
};

export class SavedListSharingDomainError extends Error {
  readonly code: "sharing-already-configured" | "sharing-not-configured" | "invalid-sharing-policy";
  constructor(code: SavedListSharingDomainError["code"], message: string) {
    super(message);
    this.name = "SavedListSharingDomainError";
    this.code = code;
  }
}

export const decideSavedListSharing: AggregateDecider<
  SavedListSharingState,
  SavedListSharingCommand,
  SavedListSharingEvent
> = (state, command) => {
  switch (command.type) {
    case "ConfigureSavedListSharing":
      if (state.identity) {
        throw new SavedListSharingDomainError(
          "sharing-already-configured",
          "Saved List sharing is already configured.",
        );
      }
      return [
        {
          type: "collections.saved-list-sharing.configured",
          data: {
            eventSchemaVersion: savedListSharingEventSchemaVersion,
            commandId: command.commandId,
            listId: command.listId,
            ownerAccountId: command.ownerAccountId,
            disclosure: privateSavedListSharingDisclosure,
            configuredAt: normalizeTimestamp(command.configuredAt),
          },
        },
      ];
    case "ChangeSavedListDisclosure": {
      const identity = requireIdentity(state);
      const disclosure = normalizeDisclosure(command.disclosure);
      if (
        disclosure.showTrackedQuantities === state.disclosure.showTrackedQuantities &&
        disclosure.showCurrentEstimatedValue === state.disclosure.showCurrentEstimatedValue
      )
        return [];
      return [
        {
          type: "collections.saved-list-sharing.disclosure-changed",
          data: {
            eventSchemaVersion: savedListSharingEventSchemaVersion,
            commandId: command.commandId,
            listId: identity.listId,
            disclosure,
            changedAt: normalizeTimestamp(command.changedAt),
          },
        },
      ];
    }
    case "RotateSavedListUnlistedAccess": {
      const identity = requireIdentity(state);
      return [
        {
          type: "collections.saved-list-sharing.unlisted-access-rotated",
          data: {
            eventSchemaVersion: savedListSharingEventSchemaVersion,
            commandId: command.commandId,
            listId: identity.listId,
            generation: state.unlistedAccess.generation + 1,
            keyId: requiredText(command.keyId, "Capability key ID"),
            verifier: normalizeVerifier(command.verifier),
            rotatedAt: normalizeTimestamp(command.rotatedAt),
          },
        },
      ];
    }
    case "RevokeSavedListUnlistedAccess": {
      const identity = requireIdentity(state);
      if (!state.unlistedAccess.verifier) return [];
      return [
        {
          type: "collections.saved-list-sharing.unlisted-access-revoked",
          data: {
            eventSchemaVersion: savedListSharingEventSchemaVersion,
            commandId: command.commandId,
            listId: identity.listId,
            generation: state.unlistedAccess.generation + 1,
            revokedAt: normalizeTimestamp(command.revokedAt),
          },
        },
      ];
    }
  }
};

export const evolveSavedListSharing: AggregateEvolver<SavedListSharingState, SavedListSharingEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "collections.saved-list-sharing.configured":
      return {
        ...state,
        identity: { listId: event.data.listId, ownerAccountId: event.data.ownerAccountId },
        disclosure: event.data.disclosure,
        changedAt: event.data.configuredAt,
      };
    case "collections.saved-list-sharing.disclosure-changed":
      return { ...state, disclosure: event.data.disclosure, changedAt: event.data.changedAt };
    case "collections.saved-list-sharing.unlisted-access-rotated":
      return {
        ...state,
        unlistedAccess: {
          generation: event.data.generation,
          keyId: event.data.keyId,
          verifier: event.data.verifier,
          changedAt: event.data.rotatedAt,
        },
        changedAt: event.data.rotatedAt,
      };
    case "collections.saved-list-sharing.unlisted-access-revoked":
      return {
        ...state,
        unlistedAccess: {
          generation: event.data.generation,
          keyId: null,
          verifier: null,
          changedAt: event.data.revokedAt,
        },
        changedAt: event.data.revokedAt,
      };
  }
};

export function toSavedListSharingSnapshot(state: SavedListSharingState, version: number): SavedListSharingSnapshot {
  const identity = requireIdentity(state);
  if (!state.changedAt) {
    throw new SavedListSharingDomainError("sharing-not-configured", "Saved List sharing is not configured.");
  }
  return {
    contractVersion: 1,
    listId: identity.listId,
    ownerAccountId: identity.ownerAccountId,
    disclosure: state.disclosure,
    unlistedAccess: {
      active: Boolean(state.unlistedAccess.verifier),
      generation: state.unlistedAccess.generation,
      changedAt: state.unlistedAccess.changedAt,
    },
    changedAt: state.changedAt,
    version,
  };
}

function requireIdentity(state: SavedListSharingState) {
  if (!state.identity) {
    throw new SavedListSharingDomainError("sharing-not-configured", "Saved List sharing must be configured first.");
  }
  return state.identity;
}
function normalizeDisclosure(disclosure: SavedListSharingDisclosure): SavedListSharingDisclosure {
  if (
    typeof disclosure.showTrackedQuantities !== "boolean" ||
    typeof disclosure.showCurrentEstimatedValue !== "boolean"
  ) {
    throw new SavedListSharingDomainError("invalid-sharing-policy", "Saved List disclosure controls are invalid.");
  }
  return { ...disclosure };
}
function normalizeVerifier(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw new SavedListSharingDomainError("invalid-sharing-policy", "Unlisted access verifier is invalid.");
  }
  return normalized;
}
function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new SavedListSharingDomainError("invalid-sharing-policy", `${field} is required.`);
  return normalized;
}
function normalizeTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new SavedListSharingDomainError("invalid-sharing-policy", "Saved List sharing timestamp is invalid.");
  }
  return timestamp.toISOString();
}
