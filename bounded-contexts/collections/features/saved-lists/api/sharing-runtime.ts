import { createHash } from "node:crypto";
import { createAggregateCommandHandler, applyEvents, type EventStore } from "@chase-sets/event-core";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { createSavedListSharingEventCodec } from "../domain/sharing-codec";
import type { SavedListCommandId, SavedListId, SavedListOwnerSnapshot } from "../domain/contracts";
import {
  savedListSharingReceiptSchemaVersion,
  type SavedListCapabilityService,
  type SavedListSharingCommandOutcome,
  type SavedListSharingCommandReceipt,
  type SavedListSharingCommandResult,
  type SavedListSharingDisclosure,
  type SavedListSharingSnapshot,
} from "../domain/sharing-contracts";
import {
  decideSavedListSharing,
  evolveSavedListSharing,
  initialSavedListSharingState,
  toSavedListSharingSnapshot,
  type SavedListSharingCommand,
  type SavedListSharingEvent,
  type SavedListSharingState,
} from "../domain/sharing-domain";

export type SavedListOwnerSnapshotReader = Readonly<{
  getOwnerSnapshot: (
    input: Readonly<{ listId: SavedListId; ownerAccountId: AccountId }>,
    context: EventStoreContext,
  ) => Promise<SavedListOwnerSnapshot | null>;
}>;

export type SavedListSharingRuntimeDeps = Readonly<{
  eventStore: EventStore;
  ownerSnapshots: SavedListOwnerSnapshotReader;
  capabilities: SavedListCapabilityService;
  clock?: () => string;
}>;

export type ChangeSavedListDisclosureInput = Readonly<{
  commandId: SavedListCommandId;
  listId: SavedListId;
  ownerAccountId: AccountId;
  expectedVersion: number;
  disclosure: SavedListSharingDisclosure;
}>;
export type RotateSavedListUnlistedAccessInput = Readonly<{
  commandId: SavedListCommandId;
  listId: SavedListId;
  ownerAccountId: AccountId;
  expectedVersion: number;
}>;
export type RevokeSavedListUnlistedAccessInput = RotateSavedListUnlistedAccessInput;
export type GetSavedListSharingInput = Readonly<{ listId: SavedListId; ownerAccountId: AccountId }>;

export type SavedListSharingServices = Readonly<{
  changeDisclosure: (
    input: ChangeSavedListDisclosureInput,
    context: EventStoreContext,
  ) => Promise<SavedListSharingCommandResult>;
  rotateUnlistedAccess: (
    input: RotateSavedListUnlistedAccessInput,
    context: EventStoreContext,
  ) => Promise<SavedListSharingCommandResult>;
  revokeUnlistedAccess: (
    input: RevokeSavedListUnlistedAccessInput,
    context: EventStoreContext,
  ) => Promise<SavedListSharingCommandResult>;
  getSharing: (input: GetSavedListSharingInput, context: EventStoreContext) => Promise<SavedListSharingSnapshot | null>;
}>;

export class SavedListSharingAuthorizationError extends Error {
  constructor() {
    super("Saved List sharing access was denied.");
    this.name = "SavedListSharingAuthorizationError";
  }
}
export class SavedListSharingArchivedError extends Error {
  constructor() {
    super("Archived Saved Lists cannot be shared.");
    this.name = "SavedListSharingArchivedError";
  }
}
export class SavedListSharingConcurrencyConflictError extends Error {
  readonly expectedVersion: number;
  readonly latest: SavedListSharingSnapshot;
  constructor(expectedVersion: number, latest: SavedListSharingSnapshot) {
    super("Saved List sharing changed before this request was applied.");
    this.name = "SavedListSharingConcurrencyConflictError";
    this.expectedVersion = expectedVersion;
    this.latest = latest;
  }
}
export class SavedListSharingIdempotencyConflictError extends Error {
  constructor(commandId: SavedListCommandId) {
    super(`Saved List sharing command '${commandId}' was already used for another request.`);
    this.name = "SavedListSharingIdempotencyConflictError";
  }
}

type StoredSharingReceipt = Readonly<{
  schemaVersion: typeof savedListSharingReceiptSchemaVersion;
  commandId: SavedListCommandId;
  fingerprint: string;
  outcome: SavedListSharingCommandOutcome;
  previousVersion: number;
  committedVersion: number;
  capabilityKeyId: string | null;
}>;

export function createSavedListSharingRuntime(deps: SavedListSharingRuntimeDeps): SavedListSharingServices {
  const repository = createSharingRepository(deps.eventStore);
  const now = deps.clock ?? (() => new Date().toISOString());

  async function requireActiveOwner(
    listId: SavedListId,
    ownerAccountId: AccountId,
    context: EventStoreContext,
  ): Promise<SavedListOwnerSnapshot> {
    if (context.audit.forAccountId !== ownerAccountId) throw new SavedListSharingAuthorizationError();
    let ownerSnapshot: SavedListOwnerSnapshot | null;
    try {
      ownerSnapshot = await deps.ownerSnapshots.getOwnerSnapshot({ listId, ownerAccountId }, context);
    } catch {
      throw new SavedListSharingAuthorizationError();
    }
    if (!ownerSnapshot) throw new SavedListSharingAuthorizationError();
    if (ownerSnapshot.lifecycle === "archived") throw new SavedListSharingArchivedError();
    return ownerSnapshot;
  }

  async function execute(
    input: Readonly<{
      commandId: SavedListCommandId;
      listId: SavedListId;
      ownerAccountId: AccountId;
      expectedVersion: number;
      fingerprint: string;
      outcome: SavedListSharingCommandOutcome;
      buildCommand: (state: SavedListSharingState) => Readonly<{
        command: SavedListSharingCommand;
        capabilityKeyId?: string;
      }>;
    }>,
    context: EventStoreContext,
  ): Promise<SavedListSharingCommandResult> {
    await requireActiveOwner(input.listId, input.ownerAccountId, context);
    const streamId = savedListSharingStreamId(input.listId);
    const loaded = await repository.load(streamId);
    const priorReceipt = findStoredReceipt(loaded.storedEvents, input.commandId);
    if (priorReceipt) {
      assertSharingOwner(loaded.state, input.ownerAccountId);
      if (priorReceipt.fingerprint !== input.fingerprint) {
        throw new SavedListSharingIdempotencyConflictError(input.commandId);
      }
      return sharingResult(
        loaded.state,
        loaded.version,
        input.listId,
        priorReceipt,
        true,
        priorReceipt.outcome === "unlisted-access-rotated" && priorReceipt.capabilityKeyId
          ? deps.capabilities.reissue({
              listId: input.listId,
              commandId: input.commandId,
              keyId: priorReceipt.capabilityKeyId,
            })
          : null,
      );
    }
    if (loaded.version !== input.expectedVersion) {
      if (!loaded.state.identity) throw new SavedListSharingAuthorizationError();
      assertSharingOwner(loaded.state, input.ownerAccountId);
      throw new SavedListSharingConcurrencyConflictError(
        input.expectedVersion,
        toSavedListSharingSnapshot(loaded.state, loaded.version),
      );
    }

    const configuredAt = now();
    const setupEvents = loaded.state.identity
      ? []
      : decideSavedListSharing(initialSavedListSharingState, {
          type: "ConfigureSavedListSharing",
          commandId: input.commandId,
          listId: input.listId,
          ownerAccountId: input.ownerAccountId,
          configuredAt,
        });
    const configuredState = applyEvents(loaded.state, evolveSavedListSharing, setupEvents);
    const built = input.buildCommand(configuredState);
    const commandEvents = decideSavedListSharing(configuredState, built.command);
    const events = [...setupEvents, ...commandEvents];
    const outcome =
      commandEvents.length === 0 ? (setupEvents.length === 0 ? "no-change" : "configured") : input.outcome;
    const storedReceipt: StoredSharingReceipt = {
      schemaVersion: savedListSharingReceiptSchemaVersion,
      commandId: input.commandId,
      fingerprint: input.fingerprint,
      outcome,
      previousVersion: loaded.version,
      committedVersion: loaded.version + events.length,
      capabilityKeyId: built.capabilityKeyId ?? null,
    };
    if (events.length === 0) {
      return sharingResult(loaded.state, loaded.version, input.listId, storedReceipt, false, null);
    }
    try {
      const storedEvents = await repository.append({
        streamId,
        expectedVersion: loaded.version === 0 ? "no_stream" : loaded.version,
        context,
        events,
        metadata: { savedListSharingReceipt: storedReceipt as unknown as JsonValue },
      });
      const state = applyEvents(loaded.state, evolveSavedListSharing, events);
      const version = storedEvents.at(-1)?.streamVersion ?? loaded.version;
      const secret =
        outcome === "unlisted-access-rotated" && built.capabilityKeyId
          ? deps.capabilities.reissue({
              listId: input.listId,
              commandId: input.commandId,
              keyId: built.capabilityKeyId,
            })
          : null;
      return sharingResult(state, version, input.listId, storedReceipt, false, secret);
    } catch (error) {
      if (isConcurrencyConflict(error)) {
        const current = await repository.load(streamId);
        assertSharingOwner(current.state, input.ownerAccountId);
        throw new SavedListSharingConcurrencyConflictError(
          input.expectedVersion,
          toSavedListSharingSnapshot(current.state, current.version),
        );
      }
      throw error;
    }
  }

  return {
    changeDisclosure: (input, context) =>
      execute(
        {
          ...input,
          fingerprint: requestFingerprint("change-disclosure", input),
          outcome: "disclosure-changed",
          buildCommand: () => ({
            command: {
              type: "ChangeSavedListDisclosure",
              commandId: input.commandId,
              disclosure: input.disclosure,
              changedAt: now(),
            },
          }),
        },
        context,
      ),
    rotateUnlistedAccess: (input, context) =>
      execute(
        {
          ...input,
          fingerprint: requestFingerprint("rotate-unlisted-access", input),
          outcome: "unlisted-access-rotated",
          buildCommand: () => {
            const capability = deps.capabilities.mint({ listId: input.listId, commandId: input.commandId });
            return {
              command: {
                type: "RotateSavedListUnlistedAccess",
                commandId: input.commandId,
                keyId: capability.keyId,
                verifier: capability.verifier,
                rotatedAt: now(),
              },
              capabilityKeyId: capability.keyId,
            };
          },
        },
        context,
      ),
    revokeUnlistedAccess: (input, context) =>
      execute(
        {
          ...input,
          fingerprint: requestFingerprint("revoke-unlisted-access", input),
          outcome: "unlisted-access-revoked",
          buildCommand: () => ({
            command: { type: "RevokeSavedListUnlistedAccess", commandId: input.commandId, revokedAt: now() },
          }),
        },
        context,
      ),
    getSharing: async (input, context) => {
      await requireActiveOwner(input.listId, input.ownerAccountId, context);
      const loaded = await repository.load(savedListSharingStreamId(input.listId));
      if (!loaded.state.identity) return null;
      assertSharingOwner(loaded.state, input.ownerAccountId);
      return toSavedListSharingSnapshot(loaded.state, loaded.version);
    },
  };
}

function createSharingRepository(eventStore: EventStore) {
  return createAggregateCommandHandler<SavedListSharingState, SavedListSharingCommand, SavedListSharingEvent>({
    eventStore,
    codec: createSavedListSharingEventCodec(),
    initialState: () => initialSavedListSharingState,
    evolve: evolveSavedListSharing,
    decide: decideSavedListSharing,
  }).repository;
}
function savedListSharingStreamId(listId: SavedListId) {
  return `collections.saved-list-sharing-${listId}`;
}
function assertSharingOwner(state: SavedListSharingState, ownerAccountId: AccountId) {
  if (state.identity?.ownerAccountId !== ownerAccountId) throw new SavedListSharingAuthorizationError();
}
function findStoredReceipt(events: readonly StoredEvent[], commandId: SavedListCommandId): StoredSharingReceipt | null {
  for (const event of events) {
    const candidate = event.metadata.savedListSharingReceipt;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (record.commandId === commandId && record.schemaVersion === savedListSharingReceiptSchemaVersion) {
      return record as unknown as StoredSharingReceipt;
    }
  }
  return null;
}
function sharingResult(
  state: SavedListSharingState,
  version: number,
  listId: SavedListId,
  stored: StoredSharingReceipt,
  replayed: boolean,
  unlistedSecret: SavedListSharingCommandResult["unlistedSecret"],
): SavedListSharingCommandResult {
  const receipt: SavedListSharingCommandReceipt = {
    schemaVersion: stored.schemaVersion,
    commandId: stored.commandId,
    listId,
    outcome: stored.outcome,
    previousVersion: stored.previousVersion,
    committedVersion: stored.committedVersion,
    replayed,
  };
  return { receipt, sharing: toSavedListSharingSnapshot(state, version), unlistedSecret };
}
function requestFingerprint(kind: string, input: object) {
  return `sha256:${createHash("sha256").update(stableStringify({ kind, input })).digest("hex")}`;
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function isConcurrencyConflict(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "concurrency_conflict";
}
