import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "../../contracts/event-core";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  type CatalogLifecycleStatus,
  type EmptyEventData,
  type FieldBehavior,
  type FieldValueType,
} from "./common";
import type { FieldId } from "./ids";

export type FieldState = Readonly<{
  id: FieldId | null;
  key: string | null;
  name: string | null;
  description: string;
  status: CatalogLifecycleStatus;
  valueType: FieldValueType;
  behavior: FieldBehavior;
}>;

export const initialFieldState: FieldState = {
  id: null,
  key: null,
  name: null,
  description: "",
  status: "draft",
  valueType: "string",
  behavior: {
    filterable: false,
    searchable: false,
    sortable: false,
  },
};

export type CreateFieldCommand = Readonly<{
  type: "CreateField";
  fieldId: FieldId;
  key: string;
  name: string;
  description?: string;
  valueType: FieldValueType;
  behavior: FieldBehavior;
}>;

export type ConfigureFieldCommand = Readonly<{
  type: "ConfigureField";
  key: string;
  name: string;
  description?: string;
  valueType: FieldValueType;
  behavior: FieldBehavior;
}>;

export type ActivateFieldCommand = Readonly<{
  type: "ActivateField";
}>;

export type DeprecateFieldCommand = Readonly<{
  type: "DeprecateField";
}>;

export type ArchiveFieldCommand = Readonly<{
  type: "ArchiveField";
}>;

export type FieldCommand =
  | CreateFieldCommand
  | ConfigureFieldCommand
  | ActivateFieldCommand
  | DeprecateFieldCommand
  | ArchiveFieldCommand;

type FieldConfiguration = Readonly<{
  key: string;
  name: string;
  description: string;
  valueType: FieldValueType;
  behavior: FieldBehavior;
}>;

export type FieldCreatedEvent = DomainEvent<
  "catalog.field.created",
  Readonly<{
    fieldId: FieldId;
  }> &
    FieldConfiguration
>;

export type FieldConfiguredEvent = DomainEvent<
  "catalog.field.configured",
  FieldConfiguration
>;

export type FieldActivatedEvent = DomainEvent<
  "catalog.field.activated",
  EmptyEventData
>;

export type FieldDeprecatedEvent = DomainEvent<
  "catalog.field.deprecated",
  EmptyEventData
>;

export type FieldArchivedEvent = DomainEvent<
  "catalog.field.archived",
  EmptyEventData
>;

export type FieldEvent =
  | FieldCreatedEvent
  | FieldConfiguredEvent
  | FieldActivatedEvent
  | FieldDeprecatedEvent
  | FieldArchivedEvent;

export const decideField: AggregateDecider<FieldState, FieldCommand, FieldEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "CreateField":
      assert(state.id === null, "Field has already been created.");

      return [
        {
          type: "catalog.field.created",
          data: {
            fieldId: command.fieldId,
            key: command.key.trim(),
            name: command.name.trim(),
            description: command.description?.trim() ?? "",
            valueType: command.valueType,
            behavior: normalizeBehavior(command.behavior),
          },
        },
      ];
    case "ConfigureField":
      requireCreatedField(state);
      assert(state.status !== "archived", "Archived fields cannot be reconfigured.");

      return [
        {
          type: "catalog.field.configured",
          data: {
            key: command.key.trim(),
            name: command.name.trim(),
            description: command.description?.trim() ?? state.description,
            valueType: command.valueType,
            behavior: normalizeBehavior(command.behavior),
          },
        },
      ];
    case "ActivateField":
      requireCreatedField(state);
      assert(state.status === "draft", "Only draft fields can be activated.");

      return [
        {
          type: "catalog.field.activated",
          data: EMPTY_EVENT_DATA,
        },
      ];
    case "DeprecateField":
      requireCreatedField(state);
      assert(state.status === "active", "Only active fields can be deprecated.");

      return [
        {
          type: "catalog.field.deprecated",
          data: EMPTY_EVENT_DATA,
        },
      ];
    case "ArchiveField":
      requireCreatedField(state);
      assert(state.status === "deprecated", "Only deprecated fields can be archived.");

      return [
        {
          type: "catalog.field.archived",
          data: EMPTY_EVENT_DATA,
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveField: AggregateEvolver<FieldState, FieldEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "catalog.field.created":
      return {
        ...state,
        id: event.data.fieldId,
        key: event.data.key,
        name: event.data.name,
        description: event.data.description,
        status: "draft",
        valueType: event.data.valueType,
        behavior: normalizeBehavior(event.data.behavior),
      };
    case "catalog.field.configured":
      return {
        ...state,
        key: event.data.key,
        name: event.data.name,
        description: event.data.description,
        valueType: event.data.valueType,
        behavior: normalizeBehavior(event.data.behavior),
      };
    case "catalog.field.activated":
      return {
        ...state,
        status: "active",
      };
    case "catalog.field.deprecated":
      return {
        ...state,
        status: "deprecated",
      };
    case "catalog.field.archived":
      return {
        ...state,
        status: "archived",
      };
    default:
      return assertNever(event);
  }
};

function requireCreatedField(state: FieldState): void {
  assert(state.id !== null, "Field must be created first.");
}

function normalizeBehavior(behavior: FieldBehavior): FieldBehavior {
  return {
    filterable: behavior.filterable,
    searchable: behavior.searchable,
    sortable: behavior.sortable,
  };
}
