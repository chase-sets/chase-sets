import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "../../../../../contracts/event-core";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  hasSameMembers,
  normalizeLocalizedText,
  type CatalogLifecycleStatus,
  type OptionStatus,
  type EmptyEventData,
  type LocalizedText,
} from "../../../support/runtime-support/common";
import type { OptionId, DimensionId } from "../../../ids";

export type DimensionOption = Readonly<{
  id: OptionId;
  code: string;
  labels: LocalizedText[];
  displayOrder: number;
  numericValue: number | null;
  status: OptionStatus;
}>;

export type DimensionState = Readonly<{
  id: DimensionId | null;
  key: string | null;
  name: string | null;
  description: string;
  status: CatalogLifecycleStatus;
  options: DimensionOption[];
}>;

export const initialDimensionState: DimensionState = {
  id: null,
  key: null,
  name: null,
  description: "",
  status: "draft",
  options: [],
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

export type AddOptionCommand = Readonly<{
  type: "AddOption";
  optionId: OptionId;
  code: string;
  labels: readonly LocalizedText[];
  numericValue?: number | null;
}>;

export type ReviseOptionCommand = Readonly<{
  type: "ReviseOption";
  optionId: OptionId;
  code: string;
  labels: readonly LocalizedText[];
  numericValue?: number | null;
}>;

export type ReorderOptionsCommand = Readonly<{
  type: "ReorderOptions";
  optionIds: readonly OptionId[];
}>;

export type DeprecateOptionCommand = Readonly<{
  type: "DeprecateOption";
  optionId: OptionId;
}>;

export type ReactivateOptionCommand = Readonly<{
  type: "ReactivateOption";
  optionId: OptionId;
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
  | AddOptionCommand
  | ReviseOptionCommand
  | ReorderOptionsCommand
  | DeprecateOptionCommand
  | ReactivateOptionCommand
  | ActivateDimensionCommand
  | DeprecateDimensionCommand
  | ArchiveDimensionCommand;

type OptionSnapshot = Readonly<{
  optionId: OptionId;
  code: string;
  labels: LocalizedText[];
  displayOrder: number;
  numericValue: number | null;
  status: OptionStatus;
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

export type OptionAddedEvent = DomainEvent<
  "catalog.dimension.option-added",
  OptionSnapshot
>;

export type OptionRevisedEvent = DomainEvent<
  "catalog.dimension.option-revised",
  OptionSnapshot
>;

export type OptionsReorderedEvent = DomainEvent<
  "catalog.dimension.options-reordered",
  Readonly<{
    optionIds: OptionId[];
  }>
>;

export type OptionDeprecatedEvent = DomainEvent<
  "catalog.dimension.option-deprecated",
  Readonly<{
    optionId: OptionId;
  }>
>;

export type OptionReactivatedEvent = DomainEvent<
  "catalog.dimension.option-reactivated",
  Readonly<{
    optionId: OptionId;
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
  | OptionAddedEvent
  | OptionRevisedEvent
  | OptionsReorderedEvent
  | OptionDeprecatedEvent
  | OptionReactivatedEvent
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
    case "AddOption":
      requireCreatedDimension(state);
      assert(state.status !== "archived", "Archived dimensions cannot add options.");
      assert(
        !state.options.some((option) => option.id === command.optionId),
        "Option already exists on this dimension.",
      );
      assert(
        !state.options.some((option) => option.code === command.code.trim()),
        "Option codes must be unique within a dimension.",
      );

      return [
        {
          type: "catalog.dimension.option-added",
          data: {
            optionId: command.optionId,
            code: command.code.trim(),
            labels: normalizeLocalizedText(command.labels),
            displayOrder: state.options.length,
            numericValue: command.numericValue ?? null,
            status: "active",
          },
        },
      ];
    case "ReviseOption": {
      requireCreatedDimension(state);
      assert(state.status !== "archived", "Archived dimensions cannot revise options.");

      const option = findOption(state, command.optionId);

      assert(
        !state.options.some(
          (existingOption) =>
            existingOption.id !== command.optionId &&
            existingOption.code === command.code.trim(),
        ),
        "Option codes must remain unique within a dimension.",
      );

      return [
        {
          type: "catalog.dimension.option-revised",
          data: {
            optionId: option.id,
            code: command.code.trim(),
            labels: normalizeLocalizedText(command.labels),
            displayOrder: option.displayOrder,
            numericValue: command.numericValue ?? null,
            status: option.status,
          },
        },
      ];
    }
    case "ReorderOptions":
      requireCreatedDimension(state);
      assert(
        state.status !== "archived",
        "Archived dimensions cannot reorder options.",
      );
      assert(
        hasSameMembers(
          state.options.map((option) => option.id),
          command.optionIds,
        ),
        "Reordered options must include exactly the current set of options.",
      );

      return [
        {
          type: "catalog.dimension.options-reordered",
          data: {
            optionIds: [...command.optionIds],
          },
        },
      ];
    case "DeprecateOption":
      requireCreatedDimension(state);

      findOption(state, command.optionId);

      return [
        {
          type: "catalog.dimension.option-deprecated",
          data: {
            optionId: command.optionId,
          },
        },
      ];
    case "ReactivateOption":
      requireCreatedDimension(state);

      findOption(state, command.optionId);

      return [
        {
          type: "catalog.dimension.option-reactivated",
          data: {
            optionId: command.optionId,
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
    case "catalog.dimension.option-added":
      return {
        ...state,
        options: sortOptions([
          ...state.options,
          fromOptionSnapshot(event.data),
        ]),
      };
    case "catalog.dimension.option-revised":
      return {
        ...state,
        options: sortOptions(
          state.options.map((option) =>
            option.id === event.data.optionId
              ? fromOptionSnapshot(event.data)
              : option,
          ),
        ),
      };
    case "catalog.dimension.options-reordered":
      return {
        ...state,
        options: event.data.optionIds.map((optionId, index) => {
          const option = findOption(state, optionId);

          return {
            ...option,
            displayOrder: index,
          };
        }),
      };
    case "catalog.dimension.option-deprecated":
      return {
        ...state,
        options: state.options.map((option) =>
          option.id === event.data.optionId
            ? {
                ...option,
                status: "deprecated",
              }
            : option,
        ),
      };
    case "catalog.dimension.option-reactivated":
      return {
        ...state,
        options: state.options.map((option) =>
          option.id === event.data.optionId
            ? {
                ...option,
                status: "active",
              }
            : option,
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

function fromOptionSnapshot(snapshot: OptionSnapshot): DimensionOption {
  return {
    id: snapshot.optionId,
    code: snapshot.code,
    labels: snapshot.labels,
    displayOrder: snapshot.displayOrder,
    numericValue: snapshot.numericValue,
    status: snapshot.status,
  };
}

function findOption(state: DimensionState, optionId: OptionId): DimensionOption {
  const option = state.options.find((existingOption) => existingOption.id === optionId);

  assert(option !== undefined, "Option does not exist on this dimension.");

  return option;
}

function sortOptions(options: readonly DimensionOption[]): DimensionOption[] {
  return [...options].sort(
    (left, right) => left.displayOrder - right.displayOrder,
  );
}
