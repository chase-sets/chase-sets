import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "../../contracts/event-core";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  ensureUniqueBy,
  hasSameMembers,
  toSortedUniqueList,
  type CatalogLifecycleStatus,
  type EmptyEventData,
} from "./common";
import type {
  BlueprintId,
  ChoiceId,
  ComponentId,
  DimensionId,
  FieldId,
} from "./ids";

export type BlueprintFieldRule = Readonly<{
  fieldId: FieldId;
  required: boolean;
}>;

export type BlueprintDimensionRule = Readonly<{
  dimensionId: DimensionId;
  required: boolean;
  allowedChoiceIds: ChoiceId[];
}>;

export type BlueprintState = Readonly<{
  id: BlueprintId | null;
  key: string | null;
  name: string | null;
  description: string;
  status: CatalogLifecycleStatus;
  componentIds: ComponentId[];
  fieldRules: BlueprintFieldRule[];
  dimensionRules: BlueprintDimensionRule[];
  canonicalDimensionOrder: DimensionId[];
}>;

export const initialBlueprintState: BlueprintState = {
  id: null,
  key: null,
  name: null,
  description: "",
  status: "draft",
  componentIds: [],
  fieldRules: [],
  dimensionRules: [],
  canonicalDimensionOrder: [],
};

export type CreateBlueprintCommand = Readonly<{
  type: "CreateBlueprint";
  blueprintId: BlueprintId;
  key: string;
  name: string;
  description?: string;
}>;

export type ReviseBlueprintCommand = Readonly<{
  type: "ReviseBlueprint";
  key: string;
  name: string;
  description?: string;
}>;

export type AttachComponentToBlueprintCommand = Readonly<{
  type: "AttachComponentToBlueprint";
  componentId: ComponentId;
}>;

export type DetachComponentFromBlueprintCommand = Readonly<{
  type: "DetachComponentFromBlueprint";
  componentId: ComponentId;
}>;

export type SetBlueprintFieldsCommand = Readonly<{
  type: "SetBlueprintFields";
  fieldRules: readonly BlueprintFieldRule[];
}>;

export type SetBlueprintDimensionsCommand = Readonly<{
  type: "SetBlueprintDimensions";
  dimensionRules: readonly BlueprintDimensionRule[];
}>;

export type SetBlueprintVersionRulesCommand = Readonly<{
  type: "SetBlueprintVersionRules";
  canonicalDimensionOrder: readonly DimensionId[];
}>;

export type PublishBlueprintCommand = Readonly<{
  type: "PublishBlueprint";
}>;

export type DeprecateBlueprintCommand = Readonly<{
  type: "DeprecateBlueprint";
}>;

export type ArchiveBlueprintCommand = Readonly<{
  type: "ArchiveBlueprint";
}>;

export type BlueprintCommand =
  | CreateBlueprintCommand
  | ReviseBlueprintCommand
  | AttachComponentToBlueprintCommand
  | DetachComponentFromBlueprintCommand
  | SetBlueprintFieldsCommand
  | SetBlueprintDimensionsCommand
  | SetBlueprintVersionRulesCommand
  | PublishBlueprintCommand
  | DeprecateBlueprintCommand
  | ArchiveBlueprintCommand;

export type BlueprintCreatedEvent = DomainEvent<
  "catalog.blueprint.created",
  Readonly<{
    blueprintId: BlueprintId;
    key: string;
    name: string;
    description: string;
  }>
>;

export type BlueprintRevisedEvent = DomainEvent<
  "catalog.blueprint.revised",
  Readonly<{
    key: string;
    name: string;
    description: string;
  }>
>;

export type BlueprintComponentAttachedEvent = DomainEvent<
  "catalog.blueprint.component-attached",
  Readonly<{
    componentId: ComponentId;
  }>
>;

export type BlueprintComponentDetachedEvent = DomainEvent<
  "catalog.blueprint.component-detached",
  Readonly<{
    componentId: ComponentId;
  }>
>;

export type BlueprintFieldsSetEvent = DomainEvent<
  "catalog.blueprint.fields-set",
  Readonly<{
    fieldRules: BlueprintFieldRule[];
  }>
>;

export type BlueprintDimensionsSetEvent = DomainEvent<
  "catalog.blueprint.dimensions-set",
  Readonly<{
    dimensionRules: BlueprintDimensionRule[];
  }>
>;

export type BlueprintVersionRulesSetEvent = DomainEvent<
  "catalog.blueprint.version-rules-set",
  Readonly<{
    canonicalDimensionOrder: DimensionId[];
  }>
>;

export type BlueprintPublishedEvent = DomainEvent<
  "catalog.blueprint.published",
  EmptyEventData
>;

export type BlueprintDeprecatedEvent = DomainEvent<
  "catalog.blueprint.deprecated",
  EmptyEventData
>;

export type BlueprintArchivedEvent = DomainEvent<
  "catalog.blueprint.archived",
  EmptyEventData
>;

export type BlueprintEvent =
  | BlueprintCreatedEvent
  | BlueprintRevisedEvent
  | BlueprintComponentAttachedEvent
  | BlueprintComponentDetachedEvent
  | BlueprintFieldsSetEvent
  | BlueprintDimensionsSetEvent
  | BlueprintVersionRulesSetEvent
  | BlueprintPublishedEvent
  | BlueprintDeprecatedEvent
  | BlueprintArchivedEvent;

export const decideBlueprint: AggregateDecider<
  BlueprintState,
  BlueprintCommand,
  BlueprintEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateBlueprint":
      assert(state.id === null, "Blueprint has already been created.");

      return [
        {
          type: "catalog.blueprint.created",
          data: {
            blueprintId: command.blueprintId,
            key: command.key.trim(),
            name: command.name.trim(),
            description: command.description?.trim() ?? "",
          },
        },
      ];
    case "ReviseBlueprint":
      requireCreatedBlueprint(state);
      assert(state.status !== "archived", "Archived blueprints cannot be revised.");

      return [
        {
          type: "catalog.blueprint.revised",
          data: {
            key: command.key.trim(),
            name: command.name.trim(),
            description: command.description?.trim() ?? state.description,
          },
        },
      ];
    case "AttachComponentToBlueprint":
      requireMutableBlueprint(state);
      assert(
        !state.componentIds.includes(command.componentId),
        "Blueprint already references that component.",
      );

      return [
        {
          type: "catalog.blueprint.component-attached",
          data: {
            componentId: command.componentId,
          },
        },
      ];
    case "DetachComponentFromBlueprint":
      requireMutableBlueprint(state);
      assert(
        state.componentIds.includes(command.componentId),
        "Blueprint does not reference that component.",
      );

      return [
        {
          type: "catalog.blueprint.component-detached",
          data: {
            componentId: command.componentId,
          },
        },
      ];
    case "SetBlueprintFields":
      requireMutableBlueprint(state);

      return [
        {
          type: "catalog.blueprint.fields-set",
          data: {
            fieldRules: normalizeFieldRules(command.fieldRules),
          },
        },
      ];
    case "SetBlueprintDimensions":
      requireMutableBlueprint(state);

      return [
        {
          type: "catalog.blueprint.dimensions-set",
          data: {
            dimensionRules: normalizeDimensionRules(command.dimensionRules),
          },
        },
      ];
    case "SetBlueprintVersionRules": {
      requireMutableBlueprint(state);
      const canonicalDimensionOrder = [...command.canonicalDimensionOrder];

      assert(
        hasSameMembers(
          state.dimensionRules.map((rule) => rule.dimensionId),
          canonicalDimensionOrder,
        ),
        "Blueprint version rules must include exactly the current dimensions.",
      );

      return [
        {
          type: "catalog.blueprint.version-rules-set",
          data: {
            canonicalDimensionOrder,
          },
        },
      ];
    }
    case "PublishBlueprint":
      requireCreatedBlueprint(state);
      assert(state.status === "draft", "Only draft blueprints can be published.");
      assert(
        hasSameMembers(
          state.dimensionRules.map((rule) => rule.dimensionId),
          state.canonicalDimensionOrder,
        ),
        "Published blueprints require a canonical order for every dimension.",
      );

      return [
        {
          type: "catalog.blueprint.published",
          data: EMPTY_EVENT_DATA,
        },
      ];
    case "DeprecateBlueprint":
      requireCreatedBlueprint(state);
      assert(
        state.status === "active",
        "Only active blueprints can be deprecated.",
      );

      return [
        {
          type: "catalog.blueprint.deprecated",
          data: EMPTY_EVENT_DATA,
        },
      ];
    case "ArchiveBlueprint":
      requireCreatedBlueprint(state);
      assert(
        state.status === "deprecated",
        "Only deprecated blueprints can be archived.",
      );

      return [
        {
          type: "catalog.blueprint.archived",
          data: EMPTY_EVENT_DATA,
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveBlueprint: AggregateEvolver<BlueprintState, BlueprintEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "catalog.blueprint.created":
      return {
        ...state,
        id: event.data.blueprintId,
        key: event.data.key,
        name: event.data.name,
        description: event.data.description,
        status: "draft",
      };
    case "catalog.blueprint.revised":
      return {
        ...state,
        key: event.data.key,
        name: event.data.name,
        description: event.data.description,
      };
    case "catalog.blueprint.component-attached":
      return {
        ...state,
        componentIds: toSortedUniqueList([
          ...state.componentIds,
          event.data.componentId,
        ]),
      };
    case "catalog.blueprint.component-detached":
      return {
        ...state,
        componentIds: state.componentIds.filter(
          (componentId) => componentId !== event.data.componentId,
        ),
      };
    case "catalog.blueprint.fields-set":
      return {
        ...state,
        fieldRules: normalizeFieldRules(event.data.fieldRules),
      };
    case "catalog.blueprint.dimensions-set":
      return {
        ...state,
        dimensionRules: normalizeDimensionRules(event.data.dimensionRules),
        canonicalDimensionOrder: state.canonicalDimensionOrder.filter(
          (dimensionId) =>
            event.data.dimensionRules.some(
              (rule) => rule.dimensionId === dimensionId,
            ),
        ),
      };
    case "catalog.blueprint.version-rules-set":
      return {
        ...state,
        canonicalDimensionOrder: [...event.data.canonicalDimensionOrder],
      };
    case "catalog.blueprint.published":
      return {
        ...state,
        status: "active",
      };
    case "catalog.blueprint.deprecated":
      return {
        ...state,
        status: "deprecated",
      };
    case "catalog.blueprint.archived":
      return {
        ...state,
        status: "archived",
      };
    default:
      return assertNever(event);
  }
};

function requireCreatedBlueprint(state: BlueprintState): void {
  assert(state.id !== null, "Blueprint must be created first.");
}

function requireMutableBlueprint(state: BlueprintState): void {
  requireCreatedBlueprint(state);
  assert(
    state.status === "draft",
    "Only draft blueprints can change identity-bearing structure.",
  );
}

function normalizeFieldRule(rule: BlueprintFieldRule): BlueprintFieldRule {
  return {
    fieldId: rule.fieldId,
    required: rule.required,
  };
}

function normalizeFieldRules(
  rules: readonly BlueprintFieldRule[],
): BlueprintFieldRule[] {
  const normalized = rules.map(normalizeFieldRule);

  ensureUniqueBy(
    normalized,
    (rule) => rule.fieldId,
    "Blueprint field rules must be unique per field.",
  );

  return normalized.sort((left, right) => left.fieldId.localeCompare(right.fieldId));
}

function normalizeDimensionRule(
  rule: BlueprintDimensionRule,
): BlueprintDimensionRule {
  return {
    dimensionId: rule.dimensionId,
    required: rule.required,
    allowedChoiceIds: toSortedUniqueList(rule.allowedChoiceIds),
  };
}

function normalizeDimensionRules(
  rules: readonly BlueprintDimensionRule[],
): BlueprintDimensionRule[] {
  const normalized = rules.map(normalizeDimensionRule);

  ensureUniqueBy(
    normalized,
    (rule) => rule.dimensionId,
    "Blueprint dimension rules must be unique per dimension.",
  );

  return normalized.sort((left, right) =>
    left.dimensionId.localeCompare(right.dimensionId),
  );
}
