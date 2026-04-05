import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "../../../contracts/event-core";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  hasSameMembers,
  normalizeLocalizedText,
  type CatalogLifecycleStatus,
  type ChoiceStatus,
  type EmptyEventData,
  type LocalizedText,
} from "../common";
import type { ChoiceId, DimensionId } from "../ids";

export type DimensionChoice = Readonly<{
  id: ChoiceId;
  code: string;
  labels: LocalizedText[];
  displayOrder: number;
  numericValue: number | null;
  status: ChoiceStatus;
}>;

export type DimensionState = Readonly<{
  id: DimensionId | null;
  key: string | null;
  name: string | null;
  description: string;
  status: CatalogLifecycleStatus;
  choices: DimensionChoice[];
}>;

export const initialDimensionState: DimensionState = {
  id: null,
  key: null,
  name: null,
  description: "",
  status: "draft",
  choices: [],
};

export type CreateDimensionCommand = Readonly<{
  type: "CreateDimension";
  dimensionId: DimensionId;
  key: string;
  name: string;
  description?: string;
}>;

export type ReviseDimensionCommand = Readonly<{
  type: "ReviseDimension";
  key: string;
  name: string;
  description?: string;
}>;

export type AddChoiceCommand = Readonly<{
  type: "AddChoice";
  choiceId: ChoiceId;
  code: string;
  labels: readonly LocalizedText[];
  numericValue?: number | null;
}>;

export type ReviseChoiceCommand = Readonly<{
  type: "ReviseChoice";
  choiceId: ChoiceId;
  code: string;
  labels: readonly LocalizedText[];
  numericValue?: number | null;
}>;

export type ReorderChoicesCommand = Readonly<{
  type: "ReorderChoices";
  choiceIds: readonly ChoiceId[];
}>;

export type DeprecateChoiceCommand = Readonly<{
  type: "DeprecateChoice";
  choiceId: ChoiceId;
}>;

export type ReactivateChoiceCommand = Readonly<{
  type: "ReactivateChoice";
  choiceId: ChoiceId;
}>;

export type ActivateDimensionCommand = Readonly<{
  type: "ActivateDimension";
}>;

export type DeprecateDimensionCommand = Readonly<{
  type: "DeprecateDimension";
}>;

export type ArchiveDimensionCommand = Readonly<{
  type: "ArchiveDimension";
}>;

export type DimensionCommand =
  | CreateDimensionCommand
  | ReviseDimensionCommand
  | AddChoiceCommand
  | ReviseChoiceCommand
  | ReorderChoicesCommand
  | DeprecateChoiceCommand
  | ReactivateChoiceCommand
  | ActivateDimensionCommand
  | DeprecateDimensionCommand
  | ArchiveDimensionCommand;

type ChoiceSnapshot = Readonly<{
  choiceId: ChoiceId;
  code: string;
  labels: LocalizedText[];
  displayOrder: number;
  numericValue: number | null;
  status: ChoiceStatus;
}>;

export type DimensionCreatedEvent = DomainEvent<
  "catalog.dimension.created",
  Readonly<{
    dimensionId: DimensionId;
    key: string;
    name: string;
    description: string;
  }>
>;

export type DimensionRevisedEvent = DomainEvent<
  "catalog.dimension.revised",
  Readonly<{
    key: string;
    name: string;
    description: string;
  }>
>;

export type ChoiceAddedEvent = DomainEvent<
  "catalog.dimension.choice-added",
  ChoiceSnapshot
>;

export type ChoiceRevisedEvent = DomainEvent<
  "catalog.dimension.choice-revised",
  ChoiceSnapshot
>;

export type ChoicesReorderedEvent = DomainEvent<
  "catalog.dimension.choices-reordered",
  Readonly<{
    choiceIds: ChoiceId[];
  }>
>;

export type ChoiceDeprecatedEvent = DomainEvent<
  "catalog.dimension.choice-deprecated",
  Readonly<{
    choiceId: ChoiceId;
  }>
>;

export type ChoiceReactivatedEvent = DomainEvent<
  "catalog.dimension.choice-reactivated",
  Readonly<{
    choiceId: ChoiceId;
  }>
>;

export type DimensionActivatedEvent = DomainEvent<
  "catalog.dimension.activated",
  EmptyEventData
>;

export type DimensionDeprecatedEvent = DomainEvent<
  "catalog.dimension.deprecated",
  EmptyEventData
>;

export type DimensionArchivedEvent = DomainEvent<
  "catalog.dimension.archived",
  EmptyEventData
>;

export type DimensionEvent =
  | DimensionCreatedEvent
  | DimensionRevisedEvent
  | ChoiceAddedEvent
  | ChoiceRevisedEvent
  | ChoicesReorderedEvent
  | ChoiceDeprecatedEvent
  | ChoiceReactivatedEvent
  | DimensionActivatedEvent
  | DimensionDeprecatedEvent
  | DimensionArchivedEvent;

export const decideDimension: AggregateDecider<
  DimensionState,
  DimensionCommand,
  DimensionEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateDimension":
      assert(state.id === null, "Dimension has already been created.");

      return [
        {
          type: "catalog.dimension.created",
          data: {
            dimensionId: command.dimensionId,
            key: command.key.trim(),
            name: command.name.trim(),
            description: command.description?.trim() ?? "",
          },
        },
      ];
    case "ReviseDimension":
      requireCreatedDimension(state);
      assert(state.status !== "archived", "Archived dimensions cannot be revised.");

      return [
        {
          type: "catalog.dimension.revised",
          data: {
            key: command.key.trim(),
            name: command.name.trim(),
            description: command.description?.trim() ?? state.description,
          },
        },
      ];
    case "AddChoice":
      requireCreatedDimension(state);
      assert(state.status !== "archived", "Archived dimensions cannot add choices.");
      assert(
        !state.choices.some((choice) => choice.id === command.choiceId),
        "Choice already exists on this dimension.",
      );
      assert(
        !state.choices.some((choice) => choice.code === command.code.trim()),
        "Choice codes must be unique within a dimension.",
      );

      return [
        {
          type: "catalog.dimension.choice-added",
          data: {
            choiceId: command.choiceId,
            code: command.code.trim(),
            labels: normalizeLocalizedText(command.labels),
            displayOrder: state.choices.length,
            numericValue: command.numericValue ?? null,
            status: "active",
          },
        },
      ];
    case "ReviseChoice": {
      requireCreatedDimension(state);
      assert(state.status !== "archived", "Archived dimensions cannot revise choices.");

      const choice = findChoice(state, command.choiceId);

      assert(
        !state.choices.some(
          (existingChoice) =>
            existingChoice.id !== command.choiceId &&
            existingChoice.code === command.code.trim(),
        ),
        "Choice codes must remain unique within a dimension.",
      );

      return [
        {
          type: "catalog.dimension.choice-revised",
          data: {
            choiceId: choice.id,
            code: command.code.trim(),
            labels: normalizeLocalizedText(command.labels),
            displayOrder: choice.displayOrder,
            numericValue: command.numericValue ?? null,
            status: choice.status,
          },
        },
      ];
    }
    case "ReorderChoices":
      requireCreatedDimension(state);
      assert(
        state.status !== "archived",
        "Archived dimensions cannot reorder choices.",
      );
      assert(
        hasSameMembers(
          state.choices.map((choice) => choice.id),
          command.choiceIds,
        ),
        "Reordered choices must include exactly the current set of choices.",
      );

      return [
        {
          type: "catalog.dimension.choices-reordered",
          data: {
            choiceIds: [...command.choiceIds],
          },
        },
      ];
    case "DeprecateChoice":
      requireCreatedDimension(state);

      findChoice(state, command.choiceId);

      return [
        {
          type: "catalog.dimension.choice-deprecated",
          data: {
            choiceId: command.choiceId,
          },
        },
      ];
    case "ReactivateChoice":
      requireCreatedDimension(state);

      findChoice(state, command.choiceId);

      return [
        {
          type: "catalog.dimension.choice-reactivated",
          data: {
            choiceId: command.choiceId,
          },
        },
      ];
    case "ActivateDimension":
      requireCreatedDimension(state);
      assert(state.status === "draft", "Only draft dimensions can be activated.");

      return [
        {
          type: "catalog.dimension.activated",
          data: EMPTY_EVENT_DATA,
        },
      ];
    case "DeprecateDimension":
      requireCreatedDimension(state);
      assert(
        state.status === "active",
        "Only active dimensions can be deprecated.",
      );

      return [
        {
          type: "catalog.dimension.deprecated",
          data: EMPTY_EVENT_DATA,
        },
      ];
    case "ArchiveDimension":
      requireCreatedDimension(state);
      assert(
        state.status === "deprecated",
        "Only deprecated dimensions can be archived.",
      );

      return [
        {
          type: "catalog.dimension.archived",
          data: EMPTY_EVENT_DATA,
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveDimension: AggregateEvolver<DimensionState, DimensionEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "catalog.dimension.created":
      return {
        ...state,
        id: event.data.dimensionId,
        key: event.data.key,
        name: event.data.name,
        description: event.data.description,
        status: "draft",
      };
    case "catalog.dimension.revised":
      return {
        ...state,
        key: event.data.key,
        name: event.data.name,
        description: event.data.description,
      };
    case "catalog.dimension.choice-added":
      return {
        ...state,
        choices: sortChoices([
          ...state.choices,
          fromChoiceSnapshot(event.data),
        ]),
      };
    case "catalog.dimension.choice-revised":
      return {
        ...state,
        choices: sortChoices(
          state.choices.map((choice) =>
            choice.id === event.data.choiceId
              ? fromChoiceSnapshot(event.data)
              : choice,
          ),
        ),
      };
    case "catalog.dimension.choices-reordered":
      return {
        ...state,
        choices: event.data.choiceIds.map((choiceId, index) => {
          const choice = findChoice(state, choiceId);

          return {
            ...choice,
            displayOrder: index,
          };
        }),
      };
    case "catalog.dimension.choice-deprecated":
      return {
        ...state,
        choices: state.choices.map((choice) =>
          choice.id === event.data.choiceId
            ? {
                ...choice,
                status: "deprecated",
              }
            : choice,
        ),
      };
    case "catalog.dimension.choice-reactivated":
      return {
        ...state,
        choices: state.choices.map((choice) =>
          choice.id === event.data.choiceId
            ? {
                ...choice,
                status: "active",
              }
            : choice,
        ),
      };
    case "catalog.dimension.activated":
      return {
        ...state,
        status: "active",
      };
    case "catalog.dimension.deprecated":
      return {
        ...state,
        status: "deprecated",
      };
    case "catalog.dimension.archived":
      return {
        ...state,
        status: "archived",
      };
    default:
      return assertNever(event);
  }
};

function requireCreatedDimension(state: DimensionState): void {
  assert(state.id !== null, "Dimension must be created first.");
}

function fromChoiceSnapshot(snapshot: ChoiceSnapshot): DimensionChoice {
  return {
    id: snapshot.choiceId,
    code: snapshot.code,
    labels: snapshot.labels,
    displayOrder: snapshot.displayOrder,
    numericValue: snapshot.numericValue,
    status: snapshot.status,
  };
}

function findChoice(state: DimensionState, choiceId: ChoiceId): DimensionChoice {
  const choice = state.choices.find((existingChoice) => existingChoice.id === choiceId);

  assert(choice !== undefined, "Choice does not exist on this dimension.");

  return choice;
}

function sortChoices(choices: readonly DimensionChoice[]): DimensionChoice[] {
  return [...choices].sort(
    (left, right) => left.displayOrder - right.displayOrder,
  );
}
