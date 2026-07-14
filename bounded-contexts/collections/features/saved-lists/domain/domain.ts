import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  savedListEventSchemaVersion,
  savedListLimits,
  type SavedListCommandId,
  type SavedListCover,
  type SavedListEventSchemaVersion,
  type SavedListId,
  type SavedListLine,
  type SavedListLineId,
  type SavedListMembership,
  type SavedListOwnerSnapshot,
  type SavedListProductSelection,
  type SavedListSelectedOption,
  type SavedListState,
  type SavedListViewerDisclosure,
  type SavedListViewerSnapshot,
  type SavedListVisibility,
} from "./contracts";

type VersionedEventData<T extends Record<string, unknown>> = Readonly<
  T & {
    eventSchemaVersion: SavedListEventSchemaVersion;
    commandId: SavedListCommandId;
    listId: SavedListId;
  }
>;

export type CreateSavedListCommand = Readonly<{
  type: "CreateSavedList";
  commandId: SavedListCommandId;
  listId: SavedListId;
  ownerAccountId: AccountId;
  title: string;
  description?: string | null;
  createdAt: string;
}>;

export type ChangeSavedListDetailsCommand = Readonly<{
  type: "ChangeSavedListDetails";
  commandId: SavedListCommandId;
  title: string;
  description?: string | null;
  changedAt: string;
}>;

export type ArchiveSavedListCommand = Readonly<{
  type: "ArchiveSavedList";
  commandId: SavedListCommandId;
  archivedAt: string;
}>;

export type ChangeSavedListVisibilityCommand = Readonly<{
  type: "ChangeSavedListVisibility";
  commandId: SavedListCommandId;
  visibility: SavedListVisibility;
  changedAt: string;
}>;

export type ChangeSavedListCoverCommand = Readonly<{
  type: "ChangeSavedListCover";
  commandId: SavedListCommandId;
  lineId: SavedListLineId | null;
  changedAt: string;
}>;

export type AddSavedListLineCommand = Readonly<{
  type: "AddSavedListLine";
  commandId: SavedListCommandId;
  lineId: SavedListLineId;
  product: SavedListProductSelection;
  trackedQuantity: number;
  privateNotes?: string | null;
  privateTags?: readonly string[];
  changedAt: string;
}>;

export type ChangeSavedListLineCommand = Readonly<{
  type: "ChangeSavedListLine";
  commandId: SavedListCommandId;
  lineId: SavedListLineId;
  trackedQuantity?: number;
  privateNotes?: string | null;
  privateTags?: readonly string[];
  changedAt: string;
}>;

export type RemoveSavedListLineCommand = Readonly<{
  type: "RemoveSavedListLine";
  commandId: SavedListCommandId;
  lineId: SavedListLineId;
  changedAt: string;
}>;

export type ReorderSavedListLineCommand = Readonly<{
  type: "ReorderSavedListLine";
  commandId: SavedListCommandId;
  lineId: SavedListLineId;
  afterLineId: SavedListLineId | null;
  changedAt: string;
}>;

export type SavedListCommand =
  | CreateSavedListCommand
  | ChangeSavedListDetailsCommand
  | ArchiveSavedListCommand
  | ChangeSavedListVisibilityCommand
  | ChangeSavedListCoverCommand
  | AddSavedListLineCommand
  | ChangeSavedListLineCommand
  | RemoveSavedListLineCommand
  | ReorderSavedListLineCommand;

export type SavedListCreatedEvent = DomainEvent<
  "collections.saved-list.created",
  VersionedEventData<{
    ownerAccountId: AccountId;
    title: string;
    description: string | null;
    visibility: "private";
    createdAt: string;
  }>
>;

export type SavedListDetailsChangedEvent = DomainEvent<
  "collections.saved-list.details-changed",
  VersionedEventData<{ title: string; description: string | null; changedAt: string }>
>;

export type SavedListArchivedEvent = DomainEvent<
  "collections.saved-list.archived",
  VersionedEventData<{ archivedAt: string }>
>;

export type SavedListVisibilityChangedEvent = DomainEvent<
  "collections.saved-list.visibility-changed",
  VersionedEventData<{ visibility: SavedListVisibility; changedAt: string }>
>;

export type SavedListCoverChangedEvent = DomainEvent<
  "collections.saved-list.cover-changed",
  VersionedEventData<{ lineId: SavedListLineId | null; changedAt: string }>
>;

export type SavedListLineAddedEvent = DomainEvent<
  "collections.saved-list.line-added",
  VersionedEventData<{
    lineId: SavedListLineId;
    product: SavedListProductSelection;
    trackedQuantity: number;
    privateNotes: string | null;
    privateTags: readonly string[];
    addedAt: string;
  }>
>;

export type SavedListLineChangedEvent = DomainEvent<
  "collections.saved-list.line-changed",
  VersionedEventData<{
    lineId: SavedListLineId;
    trackedQuantity: number;
    privateNotes: string | null;
    privateTags: readonly string[];
    changedAt: string;
    changeKind: "changed" | "merged";
  }>
>;

export type SavedListLineRemovedEvent = DomainEvent<
  "collections.saved-list.line-removed",
  VersionedEventData<{ lineId: SavedListLineId; changedAt: string }>
>;

export type SavedListLineReorderedEvent = DomainEvent<
  "collections.saved-list.line-reordered",
  VersionedEventData<{ lineId: SavedListLineId; afterLineId: SavedListLineId | null; changedAt: string }>
>;

export type SavedListEvent =
  | SavedListCreatedEvent
  | SavedListDetailsChangedEvent
  | SavedListArchivedEvent
  | SavedListVisibilityChangedEvent
  | SavedListCoverChangedEvent
  | SavedListLineAddedEvent
  | SavedListLineChangedEvent
  | SavedListLineRemovedEvent
  | SavedListLineReorderedEvent;

export type SavedListEventPayloads = {
  [Event in SavedListEvent as Event["type"]]: Event["data"];
};

export const savedListEventTypes = [
  "collections.saved-list.created",
  "collections.saved-list.details-changed",
  "collections.saved-list.archived",
  "collections.saved-list.visibility-changed",
  "collections.saved-list.cover-changed",
  "collections.saved-list.line-added",
  "collections.saved-list.line-changed",
  "collections.saved-list.line-removed",
  "collections.saved-list.line-reordered",
] as const satisfies readonly SavedListEvent["type"][];

export type SavedListDomainErrorCode =
  | "list-already-created"
  | "list-not-found"
  | "list-archived"
  | "invalid-list"
  | "invalid-line"
  | "line-not-found"
  | "line-limit-reached"
  | "quantity-limit-exceeded";

export class SavedListDomainError extends Error {
  readonly code: SavedListDomainErrorCode;

  constructor(code: SavedListDomainErrorCode, message: string) {
    super(message);
    this.name = "SavedListDomainError";
    this.code = code;
  }
}

export const initialSavedListState: SavedListState = {
  identity: null,
  title: "",
  description: null,
  visibility: "private",
  lifecycle: "active",
  cover: null,
  lines: [],
  createdAt: null,
  changedAt: null,
  archivedAt: null,
};

export const decideSavedList: AggregateDecider<SavedListState, SavedListCommand, SavedListEvent> = (state, command) => {
  if (command.type === "CreateSavedList") {
    if (state.identity !== null) {
      fail("list-already-created", "Saved List has already been created.");
    }
    return [
      {
        type: "collections.saved-list.created",
        data: {
          eventSchemaVersion: savedListEventSchemaVersion,
          commandId: normalizeCommandId(command.commandId),
          listId: command.listId,
          ownerAccountId: command.ownerAccountId,
          title: normalizeRequiredText(command.title, savedListLimits.maximumTitleLength, "Saved List title"),
          description: normalizeOptionalText(
            command.description,
            savedListLimits.maximumDescriptionLength,
            "Saved List description",
          ),
          visibility: "private",
          createdAt: normalizeTimestamp(command.createdAt),
        },
      },
    ];
  }

  const identity = requireActiveList(state);
  const base = {
    eventSchemaVersion: savedListEventSchemaVersion,
    commandId: normalizeCommandId(command.commandId),
    listId: identity.listId,
  } as const;

  switch (command.type) {
    case "ChangeSavedListDetails":
      return [
        {
          type: "collections.saved-list.details-changed",
          data: {
            ...base,
            title: normalizeRequiredText(command.title, savedListLimits.maximumTitleLength, "Saved List title"),
            description: normalizeOptionalText(
              command.description,
              savedListLimits.maximumDescriptionLength,
              "Saved List description",
            ),
            changedAt: normalizeTimestamp(command.changedAt),
          },
        },
      ];
    case "ArchiveSavedList":
      return [
        {
          type: "collections.saved-list.archived",
          data: { ...base, archivedAt: normalizeTimestamp(command.archivedAt) },
        },
      ];
    case "ChangeSavedListVisibility":
      return [
        {
          type: "collections.saved-list.visibility-changed",
          data: {
            ...base,
            visibility: normalizeVisibility(command.visibility),
            changedAt: normalizeTimestamp(command.changedAt),
          },
        },
      ];
    case "ChangeSavedListCover": {
      if (command.lineId !== null) {
        requireLine(state, command.lineId);
      }
      return [
        {
          type: "collections.saved-list.cover-changed",
          data: { ...base, lineId: command.lineId, changedAt: normalizeTimestamp(command.changedAt) },
        },
      ];
    }
    case "AddSavedListLine": {
      const product = normalizeProduct(command.product);
      const quantity = normalizeTrackedQuantity(command.trackedQuantity);
      const existing = state.lines.find((line) => line.product.productId === product.productId);
      const changedAt = normalizeTimestamp(command.changedAt);
      if (existing) {
        if (!sameProductSelection(existing.product, product)) {
          fail("invalid-line", "Saved List Product identity conflicts with its selected Options.");
        }
        const mergedQuantity = existing.trackedQuantity + quantity;
        if (mergedQuantity > savedListLimits.maximumTrackedQuantity) {
          fail("quantity-limit-exceeded", "Saved List tracked quantity exceeds the supported maximum.");
        }
        return [
          {
            type: "collections.saved-list.line-changed",
            data: {
              ...base,
              lineId: existing.lineId,
              trackedQuantity: mergedQuantity,
              privateNotes: existing.privateNotes,
              privateTags: existing.privateTags,
              changedAt,
              changeKind: "merged",
            },
          },
        ];
      }
      if (state.lines.length >= savedListLimits.maximumLines) {
        fail("line-limit-reached", "Saved List has reached the supported line limit.");
      }
      return [
        {
          type: "collections.saved-list.line-added",
          data: {
            ...base,
            lineId: command.lineId,
            product,
            trackedQuantity: quantity,
            privateNotes: normalizeOptionalText(
              command.privateNotes,
              savedListLimits.maximumPrivateNotesLength,
              "Saved List private notes",
            ),
            privateTags: normalizePrivateTags(command.privateTags ?? []),
            addedAt: changedAt,
          },
        },
      ];
    }
    case "ChangeSavedListLine": {
      const line = requireLine(state, command.lineId);
      if (
        command.trackedQuantity === undefined &&
        command.privateNotes === undefined &&
        command.privateTags === undefined
      ) {
        fail("invalid-line", "Saved List line change must include at least one changed field.");
      }
      return [
        {
          type: "collections.saved-list.line-changed",
          data: {
            ...base,
            lineId: command.lineId,
            trackedQuantity:
              command.trackedQuantity === undefined
                ? line.trackedQuantity
                : normalizeTrackedQuantity(command.trackedQuantity),
            privateNotes:
              command.privateNotes === undefined
                ? line.privateNotes
                : normalizeOptionalText(
                    command.privateNotes,
                    savedListLimits.maximumPrivateNotesLength,
                    "Saved List private notes",
                  ),
            privateTags:
              command.privateTags === undefined ? line.privateTags : normalizePrivateTags(command.privateTags),
            changedAt: normalizeTimestamp(command.changedAt),
            changeKind: "changed",
          },
        },
      ];
    }
    case "RemoveSavedListLine":
      requireLine(state, command.lineId);
      return [
        {
          type: "collections.saved-list.line-removed",
          data: { ...base, lineId: command.lineId, changedAt: normalizeTimestamp(command.changedAt) },
        },
      ];
    case "ReorderSavedListLine":
      requireLine(state, command.lineId);
      if (command.afterLineId === command.lineId) {
        fail("invalid-line", "Saved List line cannot be moved after itself.");
      }
      if (command.afterLineId !== null) {
        requireLine(state, command.afterLineId);
      }
      return [
        {
          type: "collections.saved-list.line-reordered",
          data: {
            ...base,
            lineId: command.lineId,
            afterLineId: command.afterLineId,
            changedAt: normalizeTimestamp(command.changedAt),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveSavedList: AggregateEvolver<SavedListState, SavedListEvent> = (state, event) => {
  switch (event.type) {
    case "collections.saved-list.created":
      return {
        identity: { listId: event.data.listId, ownerAccountId: event.data.ownerAccountId },
        title: event.data.title,
        description: event.data.description,
        visibility: event.data.visibility,
        lifecycle: "active",
        cover: null,
        lines: [],
        createdAt: event.data.createdAt,
        changedAt: event.data.createdAt,
        archivedAt: null,
      };
    case "collections.saved-list.details-changed":
      return {
        ...state,
        title: event.data.title,
        description: event.data.description,
        changedAt: event.data.changedAt,
      };
    case "collections.saved-list.archived":
      return { ...state, lifecycle: "archived", archivedAt: event.data.archivedAt, changedAt: event.data.archivedAt };
    case "collections.saved-list.visibility-changed":
      return { ...state, visibility: event.data.visibility, changedAt: event.data.changedAt };
    case "collections.saved-list.cover-changed":
      return {
        ...state,
        cover: event.data.lineId === null ? null : { lineId: event.data.lineId },
        changedAt: event.data.changedAt,
      };
    case "collections.saved-list.line-added":
      return {
        ...state,
        lines: [
          ...state.lines,
          {
            lineId: event.data.lineId,
            product: event.data.product,
            trackedQuantity: event.data.trackedQuantity,
            privateNotes: event.data.privateNotes,
            privateTags: event.data.privateTags,
            addedAt: event.data.addedAt,
            changedAt: event.data.addedAt,
          },
        ],
        changedAt: event.data.addedAt,
      };
    case "collections.saved-list.line-changed":
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.lineId === event.data.lineId
            ? {
                ...line,
                trackedQuantity: event.data.trackedQuantity,
                privateNotes: event.data.privateNotes,
                privateTags: event.data.privateTags,
                changedAt: event.data.changedAt,
              }
            : line,
        ),
        changedAt: event.data.changedAt,
      };
    case "collections.saved-list.line-removed":
      return {
        ...state,
        cover: state.cover?.lineId === event.data.lineId ? null : state.cover,
        lines: state.lines.filter((line) => line.lineId !== event.data.lineId),
        changedAt: event.data.changedAt,
      };
    case "collections.saved-list.line-reordered": {
      const line = state.lines.find((candidate) => candidate.lineId === event.data.lineId);
      if (!line) {
        return state;
      }
      const remaining = state.lines.filter((candidate) => candidate.lineId !== event.data.lineId);
      const insertionIndex =
        event.data.afterLineId === null
          ? 0
          : Math.max(0, remaining.findIndex((candidate) => candidate.lineId === event.data.afterLineId) + 1);
      return {
        ...state,
        lines: [...remaining.slice(0, insertionIndex), line, ...remaining.slice(insertionIndex)],
        changedAt: event.data.changedAt,
      };
    }
    default:
      return assertNever(event);
  }
};

export function savedListStreamId(listId: SavedListId): string {
  return `collections.saved-list-${listId}`;
}

export function savedListMembership(state: SavedListState): SavedListMembership {
  return {
    orderedLineIds: state.lines.map((line) => line.lineId),
    lineCount: state.lines.length,
    trackedUnitCount: state.lines.reduce((sum, line) => sum + line.trackedQuantity, 0),
  };
}

export function toSavedListOwnerSnapshot(state: SavedListState, version: number): SavedListOwnerSnapshot {
  if (!state.identity || !state.createdAt || !state.changedAt) {
    fail("list-not-found", "Saved List was not found.");
  }
  return {
    contractVersion: 1,
    identity: state.identity,
    title: state.title,
    description: state.description,
    visibility: state.visibility,
    lifecycle: state.lifecycle,
    cover: state.cover,
    membership: savedListMembership(state),
    lines: state.lines.map((line, position) => ({ ...line, position })),
    createdAt: state.createdAt,
    changedAt: state.changedAt,
    archivedAt: state.archivedAt,
    version,
  };
}

export function toSavedListViewerSnapshot(
  ownerSnapshot: SavedListOwnerSnapshot,
  disclosure: SavedListViewerDisclosure,
): SavedListViewerSnapshot | null {
  if (ownerSnapshot.lifecycle === "archived" || ownerSnapshot.visibility === "private") {
    return null;
  }
  return {
    contractVersion: 1,
    listId: ownerSnapshot.identity.listId,
    title: ownerSnapshot.title,
    description: ownerSnapshot.description,
    visibility: ownerSnapshot.visibility,
    cover: ownerSnapshot.cover,
    lineCount: ownerSnapshot.membership.lineCount,
    lines: ownerSnapshot.lines.map((line) => ({
      lineId: line.lineId,
      product: line.product,
      trackedQuantity: disclosure.showTrackedQuantities ? line.trackedQuantity : null,
      position: line.position,
    })),
    changedAt: ownerSnapshot.changedAt,
    version: ownerSnapshot.version,
  };
}

function requireActiveList(state: SavedListState) {
  if (!state.identity) {
    fail("list-not-found", "Saved List must be created first.");
  }
  if (state.lifecycle === "archived") {
    fail("list-archived", "Archived Saved Lists cannot be changed.");
  }
  return state.identity;
}

function requireLine(state: SavedListState, lineId: SavedListLineId): SavedListLine {
  const line = state.lines.find((candidate) => candidate.lineId === lineId);
  if (!line) {
    fail("line-not-found", "Saved List line was not found.");
  }
  return line;
}

function normalizeProduct(product: SavedListProductSelection): SavedListProductSelection {
  const catalogItemId = normalizeRequiredText(
    product.catalogItemId,
    200,
    "Catalog Item",
  ) as typeof product.catalogItemId;
  const productId = normalizeRequiredText(product.productId, 1_000, "Product") as typeof product.productId;
  if (!productId.startsWith(`${catalogItemId}::`)) {
    fail("invalid-line", "Saved List Product must belong to its Catalog Item.");
  }
  if (product.selectedOptions.length > savedListLimits.maximumSelectedOptions) {
    fail("invalid-line", "Saved List Product has too many selected Options.");
  }
  const selectedOptions = product.selectedOptions.map(normalizeSelectedOption).sort(compareSelectedOptions);
  const dimensions = new Set(selectedOptions.map((selection) => selection.dimensionId));
  if (dimensions.size !== selectedOptions.length) {
    fail("invalid-line", "Saved List Product cannot select more than one Option per dimension.");
  }
  return { catalogItemId, productId, selectedOptions };
}

function normalizeSelectedOption(selection: SavedListSelectedOption): SavedListSelectedOption {
  return {
    dimensionId: normalizeRequiredText(selection.dimensionId, 200, "Product dimension"),
    optionId: normalizeRequiredText(selection.optionId, 200, "Product Option"),
  };
}

function compareSelectedOptions(left: SavedListSelectedOption, right: SavedListSelectedOption): number {
  return left.dimensionId === right.dimensionId
    ? left.optionId.localeCompare(right.optionId)
    : left.dimensionId.localeCompare(right.dimensionId);
}

function sameProductSelection(left: SavedListProductSelection, right: SavedListProductSelection): boolean {
  return (
    left.catalogItemId === right.catalogItemId &&
    left.productId === right.productId &&
    JSON.stringify(left.selectedOptions) === JSON.stringify(right.selectedOptions)
  );
}

function normalizePrivateTags(values: readonly string[]): readonly string[] {
  if (values.length > savedListLimits.maximumPrivateTags) {
    fail("invalid-line", "Saved List line has too many private tags.");
  }
  const normalized = values.map((value) =>
    normalizeRequiredText(value, savedListLimits.maximumPrivateTagLength, "Saved List private tag"),
  );
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function normalizeTrackedQuantity(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("invalid-line", "Saved List tracked quantity must be a positive whole number.");
  }
  if (value > savedListLimits.maximumTrackedQuantity) {
    fail("quantity-limit-exceeded", "Saved List tracked quantity exceeds the supported maximum.");
  }
  return value;
}

function normalizeVisibility(value: SavedListVisibility): SavedListVisibility {
  if (value !== "private" && value !== "unlisted" && value !== "public") {
    fail("invalid-list", "Saved List visibility is invalid.");
  }
  return value;
}

function normalizeCommandId(value: SavedListCommandId): SavedListCommandId {
  if (!String(value).startsWith("slc_")) {
    fail("invalid-list", "Saved List command ID is invalid.");
  }
  return value;
}

function normalizeRequiredText(value: string, maximumLength: number, label: string): string {
  const normalized = String(value ?? "").trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    fail("invalid-list", `${label} must contain between 1 and ${maximumLength} characters.`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined, maximumLength: number, label: string): string | null {
  const normalized = String(value ?? "").trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > maximumLength) {
    fail("invalid-list", `${label} cannot exceed ${maximumLength} characters.`);
  }
  return normalized;
}

function normalizeTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !value.endsWith("Z")) {
    fail("invalid-list", "Saved List timestamps must be ISO UTC timestamps.");
  }
  return new Date(parsed).toISOString();
}

function fail(code: SavedListDomainErrorCode, message: string): never {
  throw new SavedListDomainError(code, message);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Saved List variant: ${JSON.stringify(value)}`);
}
