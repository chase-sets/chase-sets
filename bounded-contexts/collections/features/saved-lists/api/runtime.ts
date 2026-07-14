import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { applyEvents } from "@chase-sets/event-core/domain";
import type { EventStore, EventStoreError } from "@chase-sets/event-core/event-store";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { createSavedListEventCodec } from "../domain/codec";
import {
  savedListCommandReceiptSchemaVersion,
  savedListLimits,
  type SavedListCommandId,
  type SavedListCommandOutcome,
  type SavedListCommandReceipt,
  type SavedListCommandResult,
  type SavedListId,
  type SavedListLineChangeErrorCode,
  type SavedListLineChangeResult,
  type SavedListLineId,
  type SavedListOwnerSnapshot,
  type SavedListProductCatalog,
  type SavedListProductSelection,
  type SavedListState,
  type SavedListVisibility,
} from "../domain/contracts";
import {
  decideSavedList,
  evolveSavedList,
  initialSavedListState,
  SavedListDomainError,
  savedListStreamId,
  toSavedListOwnerSnapshot,
  type SavedListCommand,
  type SavedListEvent,
} from "../domain/domain";

export type CreateSavedListInput = Readonly<{
  commandId: SavedListCommandId;
  listId: SavedListId;
  ownerAccountId: AccountId;
  title: string;
  description?: string | null;
}>;

export type ChangeSavedListDetailsInput = Readonly<{
  commandId: SavedListCommandId;
  listId: SavedListId;
  ownerAccountId: AccountId;
  expectedVersion: number;
  title: string;
  description?: string | null;
}>;

export type ArchiveSavedListInput = Readonly<{
  commandId: SavedListCommandId;
  listId: SavedListId;
  ownerAccountId: AccountId;
  expectedVersion: number;
}>;

export type ChangeSavedListVisibilityInput = Readonly<{
  commandId: SavedListCommandId;
  listId: SavedListId;
  ownerAccountId: AccountId;
  expectedVersion: number;
  visibility: SavedListVisibility;
}>;

export type ChangeSavedListCoverInput = Readonly<{
  commandId: SavedListCommandId;
  listId: SavedListId;
  ownerAccountId: AccountId;
  expectedVersion: number;
  lineId: SavedListLineId | null;
}>;

export type SavedListLineOperation =
  | Readonly<{
      operationId: string;
      kind: "add";
      lineId: SavedListLineId;
      product: SavedListProductSelection;
      trackedQuantity: number;
      privateNotes?: string | null;
      privateTags?: readonly string[];
    }>
  | Readonly<{
      operationId: string;
      kind: "change";
      lineId: SavedListLineId;
      trackedQuantity?: number;
      privateNotes?: string | null;
      privateTags?: readonly string[];
    }>
  | Readonly<{
      operationId: string;
      kind: "remove";
      lineId: SavedListLineId;
    }>
  | Readonly<{
      operationId: string;
      kind: "reorder";
      lineId: SavedListLineId;
      afterLineId: SavedListLineId | null;
    }>;

export type ApplySavedListLineChangesInput = Readonly<{
  commandId: SavedListCommandId;
  listId: SavedListId;
  ownerAccountId: AccountId;
  expectedVersion: number;
  operations: readonly SavedListLineOperation[];
}>;

export type SavedListRuntimeDeps = Readonly<{
  eventStore: EventStore;
  productCatalog: SavedListProductCatalog;
  clock?: () => string;
}>;

export type SavedListServices = Readonly<{
  createSavedList: (input: CreateSavedListInput, context: EventStoreContext) => Promise<SavedListCommandResult>;
  changeDetails: (input: ChangeSavedListDetailsInput, context: EventStoreContext) => Promise<SavedListCommandResult>;
  archiveSavedList: (input: ArchiveSavedListInput, context: EventStoreContext) => Promise<SavedListCommandResult>;
  changeVisibility: (
    input: ChangeSavedListVisibilityInput,
    context: EventStoreContext,
  ) => Promise<SavedListCommandResult>;
  changeCover: (input: ChangeSavedListCoverInput, context: EventStoreContext) => Promise<SavedListCommandResult>;
  applyLineChanges: (
    input: ApplySavedListLineChangesInput,
    context: EventStoreContext,
  ) => Promise<SavedListCommandResult>;
  getOwnerSnapshot: (
    input: Readonly<{ listId: SavedListId; ownerAccountId: AccountId }>,
    context: EventStoreContext,
  ) => Promise<SavedListOwnerSnapshot | null>;
}>;

export class SavedListAuthorizationError extends Error {
  constructor() {
    super("Saved List was not found.");
    this.name = "SavedListAuthorizationError";
  }
}

export class SavedListConcurrencyConflictError extends Error {
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly savedList: SavedListOwnerSnapshot;

  constructor(expectedVersion: number, savedList: SavedListOwnerSnapshot) {
    super(`Saved List changed from expected version ${expectedVersion} to ${savedList.version}.`);
    this.name = "SavedListConcurrencyConflictError";
    this.expectedVersion = expectedVersion;
    this.currentVersion = savedList.version;
    this.savedList = savedList;
  }
}

export class SavedListIdempotencyConflictError extends Error {
  constructor(commandId: SavedListCommandId) {
    super(`Saved List command '${commandId}' was already used for a different request.`);
    this.name = "SavedListIdempotencyConflictError";
  }
}

type StoredCommandReceipt = Readonly<{
  schemaVersion: typeof savedListCommandReceiptSchemaVersion;
  commandId: SavedListCommandId;
  fingerprint: string;
  outcome: SavedListCommandOutcome;
  previousVersion: number;
  committedVersion: number;
  lineResults: readonly SavedListLineChangeResult[];
}>;

type LoadedSavedList = Awaited<ReturnType<ReturnType<typeof createRepository>["load"]>>;

export function createSavedListRuntime(deps: SavedListRuntimeDeps): SavedListServices {
  const repository = createRepository(deps.eventStore);
  const now = deps.clock ?? (() => new Date().toISOString());

  async function load(listId: SavedListId) {
    return repository.load(savedListStreamId(listId));
  }

  async function reloadOwnerSnapshot(listId: SavedListId, ownerAccountId: AccountId, context: EventStoreContext) {
    const current = await load(listId);
    assertOwner(current.state, ownerAccountId, context);
    return toSavedListOwnerSnapshot(current.state, current.version);
  }

  async function execute(
    input: Readonly<{
      commandId: SavedListCommandId;
      listId: SavedListId;
      ownerAccountId: AccountId;
      expectedVersion: number | "no_stream";
      fingerprint: string;
      outcome: SavedListCommandOutcome;
      lineResults?: readonly SavedListLineChangeResult[];
      buildEvents: (loaded: LoadedSavedList) => readonly SavedListEvent[];
    }>,
    context: EventStoreContext,
  ): Promise<SavedListCommandResult> {
    const loaded = await load(input.listId);
    const priorReceipt = findStoredCommandReceipt(loaded.storedEvents, input.commandId);
    if (priorReceipt) {
      assertOwner(loaded.state, input.ownerAccountId, context);
      if (priorReceipt.fingerprint !== input.fingerprint) {
        throw new SavedListIdempotencyConflictError(input.commandId);
      }
      return commandResult(loaded.state, loaded.version, input.listId, priorReceipt, true);
    }

    if (input.expectedVersion === "no_stream") {
      if (loaded.version !== 0) {
        assertOwner(loaded.state, input.ownerAccountId, context);
        throw new SavedListConcurrencyConflictError(0, toSavedListOwnerSnapshot(loaded.state, loaded.version));
      }
      assertContextAccount(input.ownerAccountId, context);
    } else {
      assertOwner(loaded.state, input.ownerAccountId, context);
      if (loaded.version !== input.expectedVersion) {
        throw new SavedListConcurrencyConflictError(
          input.expectedVersion,
          toSavedListOwnerSnapshot(loaded.state, loaded.version),
        );
      }
    }

    const events = input.buildEvents(loaded);
    const storedReceipt: StoredCommandReceipt = {
      schemaVersion: savedListCommandReceiptSchemaVersion,
      commandId: input.commandId,
      fingerprint: input.fingerprint,
      outcome: events.length === 0 ? "no-change" : input.outcome,
      previousVersion: loaded.version,
      committedVersion: loaded.version + events.length,
      lineResults: input.lineResults ?? [],
    };

    if (events.length === 0) {
      return commandResult(loaded.state, loaded.version, input.listId, storedReceipt, false);
    }

    try {
      const storedEvents = await repository.append({
        streamId: savedListStreamId(input.listId),
        expectedVersion: input.expectedVersion,
        context,
        events,
        metadata: { savedListCommandReceipt: storedReceipt as unknown as JsonValue },
      });
      const state = applyEvents(loaded.state, evolveSavedList, events);
      const version = storedEvents.at(-1)?.streamVersion ?? loaded.version;
      return commandResult(state, version, input.listId, storedReceipt, false);
    } catch (error) {
      if (isConcurrencyConflict(error)) {
        throw new SavedListConcurrencyConflictError(
          input.expectedVersion === "no_stream" ? 0 : input.expectedVersion,
          await reloadOwnerSnapshot(input.listId, input.ownerAccountId, context),
        );
      }
      throw error;
    }
  }

  return {
    createSavedList: (input, context) => {
      const fingerprint = fingerprintRequest("create", input);
      return execute(
        {
          ...input,
          expectedVersion: "no_stream",
          fingerprint,
          outcome: "created",
          buildEvents: () =>
            decideSavedList(initialSavedListState, {
              type: "CreateSavedList",
              commandId: input.commandId,
              listId: input.listId,
              ownerAccountId: input.ownerAccountId,
              title: input.title,
              description: input.description,
              createdAt: now(),
            }),
        },
        context,
      );
    },
    changeDetails: (input, context) =>
      execute(
        {
          ...input,
          fingerprint: fingerprintRequest("change-details", input),
          outcome: "details-changed",
          buildEvents: ({ state }) =>
            decideSavedList(state, {
              type: "ChangeSavedListDetails",
              commandId: input.commandId,
              title: input.title,
              description: input.description,
              changedAt: now(),
            }),
        },
        context,
      ),
    archiveSavedList: (input, context) =>
      execute(
        {
          ...input,
          fingerprint: fingerprintRequest("archive", input),
          outcome: "archived",
          buildEvents: ({ state }) =>
            decideSavedList(state, { type: "ArchiveSavedList", commandId: input.commandId, archivedAt: now() }),
        },
        context,
      ),
    changeVisibility: (input, context) =>
      execute(
        {
          ...input,
          fingerprint: fingerprintRequest("change-visibility", input),
          outcome: "visibility-changed",
          buildEvents: ({ state }) =>
            decideSavedList(state, {
              type: "ChangeSavedListVisibility",
              commandId: input.commandId,
              visibility: input.visibility,
              changedAt: now(),
            }),
        },
        context,
      ),
    changeCover: (input, context) =>
      execute(
        {
          ...input,
          fingerprint: fingerprintRequest("change-cover", input),
          outcome: "cover-changed",
          buildEvents: ({ state }) =>
            decideSavedList(state, {
              type: "ChangeSavedListCover",
              commandId: input.commandId,
              lineId: input.lineId,
              changedAt: now(),
            }),
        },
        context,
      ),
    applyLineChanges: async (input, context) => {
      if (input.operations.length === 0 || input.operations.length > savedListLimits.maximumBatchOperations) {
        throw new Error(
          `Saved List line batch must contain between 1 and ${savedListLimits.maximumBatchOperations} operations.`,
        );
      }
      const fingerprint = fingerprintRequest("apply-line-changes", input);
      const loaded = await load(input.listId);
      const priorReceipt = findStoredCommandReceipt(loaded.storedEvents, input.commandId);
      if (priorReceipt) {
        assertOwner(loaded.state, input.ownerAccountId, context);
        if (priorReceipt.fingerprint !== fingerprint) {
          throw new SavedListIdempotencyConflictError(input.commandId);
        }
        return commandResult(loaded.state, loaded.version, input.listId, priorReceipt, true);
      }
      assertOwner(loaded.state, input.ownerAccountId, context);
      if (loaded.version !== input.expectedVersion) {
        throw new SavedListConcurrencyConflictError(
          input.expectedVersion,
          toSavedListOwnerSnapshot(loaded.state, loaded.version),
        );
      }

      const listIsArchived = loaded.state.lifecycle === "archived";
      const catalogResults = listIsArchived
        ? input.operations.map(() => null)
        : await resolveBatchProducts(input.operations, deps.productCatalog);
      const seenOperationIds = new Set<string>();
      const events: SavedListEvent[] = [];
      const lineResults: SavedListLineChangeResult[] = [];
      let workingState = loaded.state;
      const changedAt = now();

      for (const [index, operation] of input.operations.entries()) {
        const operationId = operation.operationId.trim();
        if (!operationId || seenOperationIds.has(operationId)) {
          lineResults.push(
            rejectedLineResult(
              operation.operationId,
              operation.lineId,
              "duplicate-operation",
              "Saved List line operation ID must be unique.",
            ),
          );
          continue;
        }
        seenOperationIds.add(operationId);

        if (listIsArchived) {
          lineResults.push(
            rejectedLineResult(
              operationId,
              operation.lineId,
              "list-archived",
              "Archived Saved Lists cannot be changed.",
            ),
          );
          continue;
        }

        const catalogError = catalogResults[index];
        if (catalogError) {
          lineResults.push(rejectedLineResult(operationId, operation.lineId, catalogError.code, catalogError.message));
          continue;
        }

        try {
          const command = lineOperationCommand(operation, input.commandId, changedAt);
          const newEvents = decideSavedList(workingState, command);
          events.push(...newEvents);
          workingState = applyEvents(workingState, evolveSavedList, newEvents);
          const event = newEvents.at(-1);
          lineResults.push({
            operationId,
            status: lineResultStatus(operation, event),
            lineId: eventLineId(event) ?? operation.lineId,
            error: null,
          });
        } catch (error) {
          if (!(error instanceof SavedListDomainError)) {
            throw error;
          }
          lineResults.push(rejectedLineResult(operationId, operation.lineId, lineErrorCode(error), error.message));
        }
      }

      return execute(
        {
          commandId: input.commandId,
          listId: input.listId,
          ownerAccountId: input.ownerAccountId,
          expectedVersion: input.expectedVersion,
          fingerprint,
          outcome: "line-changes-applied",
          lineResults,
          buildEvents: () => events,
        },
        context,
      );
    },
    getOwnerSnapshot: async (input, context) => {
      const loaded = await load(input.listId);
      if (loaded.version === 0) {
        return null;
      }
      assertOwner(loaded.state, input.ownerAccountId, context);
      return toSavedListOwnerSnapshot(loaded.state, loaded.version);
    },
  };
}

function createRepository(eventStore: EventStore) {
  return createAggregateCommandHandler<SavedListState, SavedListCommand, SavedListEvent>({
    eventStore,
    codec: createSavedListEventCodec(),
    initialState: () => initialSavedListState,
    evolve: evolveSavedList,
    decide: decideSavedList,
  }).repository;
}

function lineOperationCommand(
  operation: SavedListLineOperation,
  commandId: SavedListCommandId,
  changedAt: string,
): SavedListCommand {
  switch (operation.kind) {
    case "add":
      return {
        type: "AddSavedListLine",
        commandId,
        lineId: operation.lineId,
        product: operation.product,
        trackedQuantity: operation.trackedQuantity,
        privateNotes: operation.privateNotes,
        privateTags: operation.privateTags,
        changedAt,
      };
    case "change":
      return {
        type: "ChangeSavedListLine",
        commandId,
        lineId: operation.lineId,
        trackedQuantity: operation.trackedQuantity,
        privateNotes: operation.privateNotes,
        privateTags: operation.privateTags,
        changedAt,
      };
    case "remove":
      return { type: "RemoveSavedListLine", commandId, lineId: operation.lineId, changedAt };
    case "reorder":
      return {
        type: "ReorderSavedListLine",
        commandId,
        lineId: operation.lineId,
        afterLineId: operation.afterLineId,
        changedAt,
      };
    default:
      return assertNever(operation);
  }
}

async function resolveBatchProducts(
  operations: readonly SavedListLineOperation[],
  productCatalog: SavedListProductCatalog,
): Promise<readonly (Readonly<{ code: SavedListLineChangeErrorCode; message: string }> | null)[]> {
  return Promise.all(
    operations.map(async (operation) => {
      if (operation.kind !== "add") {
        return null;
      }
      try {
        const result = await productCatalog.resolveProduct(operation.product);
        switch (result.availability) {
          case "active":
            return result.product && sameProduct(result.product, operation.product)
              ? null
              : { code: "invalid-product" as const, message: "Catalog resolved a different Product selection." };
          case "retired":
            return { code: "product-retired" as const, message: "Retired Products cannot be added to a Saved List." };
          case "missing":
            return { code: "product-not-found" as const, message: "Product was not found in Catalog." };
          case "unavailable":
            return { code: "catalog-unavailable" as const, message: "Catalog Product validation is unavailable." };
          default:
            return assertNever(result.availability);
        }
      } catch {
        return { code: "catalog-unavailable" as const, message: "Catalog Product validation is unavailable." };
      }
    }),
  );
}

function sameProduct(left: SavedListProductSelection, right: SavedListProductSelection): boolean {
  return stableStringify(canonicalProduct(left)) === stableStringify(canonicalProduct(right));
}

function canonicalProduct(product: SavedListProductSelection) {
  return {
    catalogItemId: String(product.catalogItemId).trim(),
    productId: String(product.productId).trim(),
    selectedOptions: product.selectedOptions
      .map((selection) => ({
        dimensionId: String(selection.dimensionId).trim(),
        optionId: String(selection.optionId).trim(),
      }))
      .sort((left, right) =>
        left.dimensionId === right.dimensionId
          ? left.optionId.localeCompare(right.optionId)
          : left.dimensionId.localeCompare(right.dimensionId),
      ),
  };
}

function assertOwner(state: SavedListState, ownerAccountId: AccountId, context: EventStoreContext): void {
  assertContextAccount(ownerAccountId, context);
  if (!state.identity || state.identity.ownerAccountId !== ownerAccountId) {
    throw new SavedListAuthorizationError();
  }
}

function assertContextAccount(ownerAccountId: AccountId, context: EventStoreContext): void {
  if (context.audit.forAccountId !== ownerAccountId) {
    throw new SavedListAuthorizationError();
  }
}

function commandResult(
  state: SavedListState,
  currentVersion: number,
  listId: SavedListId,
  stored: StoredCommandReceipt,
  replayed: boolean,
): SavedListCommandResult {
  const receipt: SavedListCommandReceipt = {
    schemaVersion: stored.schemaVersion,
    commandId: stored.commandId,
    listId,
    outcome: stored.outcome,
    previousVersion: stored.previousVersion,
    committedVersion: stored.committedVersion,
    replayed,
    lineResults: stored.lineResults,
  };
  return { receipt, savedList: toSavedListOwnerSnapshot(state, currentVersion) };
}

function findStoredCommandReceipt(
  events: readonly StoredEvent[],
  commandId: SavedListCommandId,
): StoredCommandReceipt | null {
  for (const event of events) {
    const candidate = event.metadata.savedListCommandReceipt;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    if (record.commandId === commandId && record.schemaVersion === savedListCommandReceiptSchemaVersion) {
      return record as unknown as StoredCommandReceipt;
    }
  }
  return null;
}

function fingerprintRequest(kind: string, input: object): string {
  return `sha256:${createHash("sha256").update(stableStringify({ kind, input })).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function rejectedLineResult(
  operationId: string,
  lineId: SavedListLineId,
  code: SavedListLineChangeErrorCode,
  message: string,
): SavedListLineChangeResult {
  return { operationId, status: "rejected", lineId, error: { code, message } };
}

function lineErrorCode(error: SavedListDomainError): SavedListLineChangeErrorCode {
  switch (error.code) {
    case "list-archived":
      return "list-archived";
    case "line-not-found":
      return "line-not-found";
    case "line-limit-reached":
      return "line-limit-reached";
    case "quantity-limit-exceeded":
      return "quantity-limit-exceeded";
    default:
      return "invalid-line";
  }
}

function lineResultStatus(
  operation: SavedListLineOperation,
  event: SavedListEvent | undefined,
): Exclude<SavedListLineChangeResult["status"], "rejected"> {
  if (operation.kind === "add") {
    return event?.type === "collections.saved-list.line-changed" ? "merged" : "added";
  }
  return operation.kind === "change" ? "changed" : operation.kind === "remove" ? "removed" : "reordered";
}

function eventLineId(event: SavedListEvent | undefined): SavedListLineId | null {
  return event && "lineId" in event.data ? (event.data.lineId as SavedListLineId | null) : null;
}

function isConcurrencyConflict(error: unknown): error is EventStoreError {
  return error instanceof Error && "code" in error && error.code === "concurrency_conflict";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Saved List variant: ${JSON.stringify(value)}`);
}
