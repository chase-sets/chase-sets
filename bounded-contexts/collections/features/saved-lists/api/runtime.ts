import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { EventStreamTooLongError } from "@chase-sets/event-core/complete-stream";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
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
  readLineChangesReceipt: (
    input: ApplySavedListLineChangesInput,
    context: EventStoreContext,
  ) => Promise<SavedListCommandResult | null>;
  readCreationReceipt: (
    input: CreateSavedListInput,
    context: EventStoreContext,
  ) => Promise<SavedListCommandResult | null>;
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

export class SavedListHistoryLimitReachedError extends Error {
  readonly code = "saved-list-history-limit-reached";

  constructor() {
    super(`Saved List history reached its ${savedListLimits.maximumHistoryEvents} event limit.`);
    this.name = "SavedListHistoryLimitReachedError";
  }
}

type StoredCommandReceipt = Readonly<{
  schemaVersion: typeof savedListCommandReceiptSchemaVersion;
  commandId: SavedListCommandId;
  fingerprint: string;
  fingerprintScheme?: "semantic-v1";
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
    try {
      return await repository.load(savedListStreamId(listId));
    } catch (error) {
      if (error instanceof EventStreamTooLongError) {
        throw new SavedListHistoryLimitReachedError();
      }
      throw error;
    }
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
      fingerprintScheme?: "semantic-v1";
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
      if (input.expectedVersion === "no_stream") {
        const event = loaded.storedEvents.find((event) => event.payload.commandId === input.commandId)!;
        const expected = createSavedListEventCodec().encode(input.buildEvents(loaded)[0]!);
        if (
          priorReceipt.previousVersion !== 0 ||
          priorReceipt.committedVersion !== 1 ||
          priorReceipt.outcome !== "created" ||
          event.eventType !== expected.eventType ||
          stableStringify(event.payload) !==
            stableStringify({ ...expected.payload, createdAt: event.payload.createdAt })
        )
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
      ...(input.fingerprintScheme ? { fingerprintScheme: input.fingerprintScheme } : {}),
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
      recordCommittedEvents(storedEvents, "collections");
      const state = applyEvents(loaded.state, evolveSavedList, events);
      const version = storedEvents.at(-1)?.streamVersion ?? loaded.version;
      return commandResult(state, version, input.listId, storedReceipt, false);
    } catch (error) {
      if (error instanceof EventStreamTooLongError) {
        throw new SavedListHistoryLimitReachedError();
      }
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
      const fingerprint = lineChangesFingerprint(input);
      const loaded = await load(input.listId);
      const priorReceipt = findStoredCommandReceipt(loaded.storedEvents, input.commandId);
      if (priorReceipt) {
        assertOwner(loaded.state, input.ownerAccountId, context);
        assertLineChangesReceipt(loaded.storedEvents, input, priorReceipt);
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
          fingerprintScheme: "semantic-v1",
          outcome: "line-changes-applied",
          lineResults,
          buildEvents: () => events,
        },
        context,
      );
    },
    readCreationReceipt: async (input, context) => {
      const loaded = await load(input.listId);
      if (loaded.version === 0) return null;
      assertOwner(loaded.state, input.ownerAccountId, context);
      const receipt = findStoredCommandReceipt(loaded.storedEvents, input.commandId);
      if (!receipt) return null;
      const event = loaded.storedEvents.find((event) => event.payload.commandId === input.commandId)!;
      const expected = decideSavedList(initialSavedListState, {
        type: "CreateSavedList",
        ...input,
        createdAt: String(event.payload.createdAt),
      });
      if (
        receipt.fingerprint !== fingerprintRequest("create", input) ||
        receipt.previousVersion !== 0 ||
        receipt.committedVersion !== 1 ||
        receipt.outcome !== "created" ||
        receipt.lineResults.length !== 0 ||
        event.forAccountId !== input.ownerAccountId ||
        event.eventType !== expected[0]?.type ||
        stableStringify(event.payload) !== stableStringify(createSavedListEventCodec().encode(expected[0]!).payload)
      ) {
        throw new SavedListIdempotencyConflictError(input.commandId);
      }
      return commandResult(loaded.state, loaded.version, input.listId, receipt, true);
    },
    readLineChangesReceipt: async (input, context) => {
      const loaded = await load(input.listId);
      if (loaded.version === 0) return null;
      assertOwner(loaded.state, input.ownerAccountId, context);
      const receipt = findStoredCommandReceipt(loaded.storedEvents, input.commandId);
      if (!receipt) return null;
      assertLineChangesReceipt(loaded.storedEvents, input, receipt);
      return commandResult(loaded.state, loaded.version, input.listId, receipt, true);
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
    maxEvents: savedListLimits.maximumHistoryEvents,
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
  for (const event of events.filter((event) => event.payload.commandId === commandId)) {
    const candidate = event.metadata.savedListCommandReceipt;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new SavedListIdempotencyConflictError(commandId);
    }
    const record = candidate as Record<string, unknown>;
    if (record.commandId === commandId && record.schemaVersion === savedListCommandReceiptSchemaVersion) {
      const receipt = record as unknown as StoredCommandReceipt;
      const group = events.filter((candidate) => candidate.payload.commandId === commandId);
      if (
        !Number.isInteger(receipt.previousVersion) ||
        receipt.previousVersion < 0 ||
        !Number.isInteger(receipt.committedVersion) ||
        receipt.committedVersion <= receipt.previousVersion ||
        group.length !== receipt.committedVersion - receipt.previousVersion ||
        !Array.isArray(receipt.lineResults) ||
        typeof receipt.fingerprint !== "string" ||
        group.some(
          (candidate, index) =>
            candidate.streamVersion !== receipt.previousVersion + index + 1 ||
            candidate.forAccountId !== event.forAccountId ||
            candidate.streamId !== event.streamId ||
            stableStringify(candidate.metadata.savedListCommandReceipt) !== stableStringify(record),
        )
      ) {
        throw new SavedListIdempotencyConflictError(commandId);
      }
      return receipt;
    }
    throw new SavedListIdempotencyConflictError(commandId);
  }
  return null;
}

function lineChangesFingerprint(input: ApplySavedListLineChangesInput): string {
  const { expectedVersion: _version, ...semantic } = input;
  return fingerprintRequest("apply-line-changes:semantic-v1", semantic);
}

function assertLineChangesReceipt(
  events: readonly StoredEvent[],
  input: ApplySavedListLineChangesInput,
  receipt: StoredCommandReceipt,
) {
  const expected =
    receipt.fingerprintScheme === "semantic-v1"
      ? lineChangesFingerprint(input)
      : fingerprintRequest("apply-line-changes", { ...input, expectedVersion: receipt.previousVersion });
  const fail = () => {
    throw new SavedListIdempotencyConflictError(input.commandId);
  };
  if (
    receipt.fingerprint !== expected ||
    receipt.outcome !== "line-changes-applied" ||
    receipt.lineResults.length !== input.operations.length
  )
    fail();
  const codec = createSavedListEventCodec();
  let state = applyEvents(
    initialSavedListState,
    evolveSavedList,
    events.filter((event) => event.streamVersion <= receipt.previousVersion).map(codec.decode),
  );
  const group = events.filter((event) => event.payload.commandId === input.commandId);
  let index = 0;
  for (const [position, operation] of input.operations.entries()) {
    const result = receipt.lineResults[position]!;
    if (result.operationId !== operation.operationId.trim()) fail();
    if (result.status === "rejected") {
      if (
        !result.error ||
        result.lineId !== operation.lineId ||
        ![
          "duplicate-operation",
          "invalid-line",
          "invalid-product",
          "product-not-found",
          "product-retired",
          "catalog-unavailable",
          "line-not-found",
          "line-limit-reached",
          "quantity-limit-exceeded",
          "list-archived",
        ].includes(result.error.code)
      )
        fail();
      continue;
    }
    if (result.error !== null) fail();
    const stored = group[index];
    if (!stored || stored.forAccountId !== input.ownerAccountId || stored.payload.listId !== input.listId) fail();
    const decided = decideSavedList(
      state,
      lineOperationCommand(operation, input.commandId, String(stored!.payload.changedAt ?? stored!.payload.addedAt)),
    );
    if (
      decided.length !== 1 ||
      stableStringify(codec.encode(decided[0]!).payload) !== stableStringify(stored!.payload) ||
      decided[0]!.type !== stored!.eventType ||
      result.lineId !== eventLineId(decided[0]) ||
      result.status !== lineResultStatus(operation, decided[0])
    )
      fail();
    state = applyEvents(state, evolveSavedList, decided);
    index += decided.length;
  }
  if (index !== group.length) fail();
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
