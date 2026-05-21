import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  ensureUniqueBy,
  hasSameMembers,
  localizedTextMapFromEnglish,
  normalizeLocalizedTextMap,
  toSortedUniqueList,
  type CatalogLifecycleStatus,
  type EmptyEventData,
  type LocalizedTextMap,
} from "../../../support/runtime-support/common";
import type { BlueprintId, OptionId, ComponentId, DimensionId, FieldId } from "../../../ids";

export type BlueprintFieldRule = Readonly<{
  fieldId: FieldId;
  required: boolean;
}>;

export type BlueprintDimensionApplicabilityClause = Readonly<{
  dimensionId: DimensionId;
  optionIds: OptionId[];
}>;

export type BlueprintDimensionRule = Readonly<{
  dimensionId: DimensionId;
  required: boolean;
  allowedOptionIds: OptionId[];
  appliesWhen?: BlueprintDimensionApplicabilityClause[];
}>;

export type BlueprintState = Readonly<{
  id: BlueprintId | null;
  key: string | null;
  name: LocalizedTextMap | null;
  description: LocalizedTextMap;
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
  description: localizedTextMapFromEnglish(""),
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
  name: LocalizedTextMap;
  description?: LocalizedTextMap;
}>;

export type ReviseBlueprintCommand = Readonly<{
  type: "ReviseBlueprint";
  key: string;
  name: LocalizedTextMap;
  description?: LocalizedTextMap;
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

export type SetBlueprintProductResolutionRulesCommand = Readonly<{
  type: "SetBlueprintProductResolutionRules";
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
  | SetBlueprintProductResolutionRulesCommand
  | PublishBlueprintCommand
  | DeprecateBlueprintCommand
  | ArchiveBlueprintCommand;

export type BlueprintCreatedEvent = DomainEvent<
  "catalog.blueprint.created",
  Readonly<{
    blueprintId: BlueprintId;
    key: string;
    name: LocalizedTextMap;
    description: LocalizedTextMap;
  }>
>;

export type BlueprintRevisedEvent = DomainEvent<
  "catalog.blueprint.revised",
  Readonly<{
    key: string;
    name: LocalizedTextMap;
    description: LocalizedTextMap;
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

export type BlueprintProductResolutionRulesSetEvent = DomainEvent<
  "catalog.blueprint.product-resolution-rules-set",
  Readonly<{
    canonicalDimensionOrder: DimensionId[];
  }>
>;

export type BlueprintPublishedEvent = DomainEvent<"catalog.blueprint.published", EmptyEventData>;

export type BlueprintDeprecatedEvent = DomainEvent<"catalog.blueprint.deprecated", EmptyEventData>;

export type BlueprintArchivedEvent = DomainEvent<"catalog.blueprint.archived", EmptyEventData>;

export type BlueprintEvent =
  | BlueprintCreatedEvent
  | BlueprintRevisedEvent
  | BlueprintComponentAttachedEvent
  | BlueprintComponentDetachedEvent
  | BlueprintFieldsSetEvent
  | BlueprintDimensionsSetEvent
  | BlueprintProductResolutionRulesSetEvent
  | BlueprintPublishedEvent
  | BlueprintDeprecatedEvent
  | BlueprintArchivedEvent;

export const decideBlueprint: AggregateDecider<BlueprintState, BlueprintCommand, BlueprintEvent> = (state, command) => {
  switch (command.type) {
    case "CreateBlueprint":
      assert(state.id === null, "Blueprint has already been created.");

      return [
        {
          type: "catalog.blueprint.created",
          data: {
            blueprintId: command.blueprintId,
            key: command.key.trim(),
            name: normalizeLocalizedTextMap(command.name, { requiredEnglish: true }),
            description: command.description
              ? normalizeLocalizedTextMap(command.description)
              : localizedTextMapFromEnglish(""),
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
            name: normalizeLocalizedTextMap(command.name, { requiredEnglish: true }),
            description: command.description ? normalizeLocalizedTextMap(command.description) : state.description,
          },
        },
      ];
    case "AttachComponentToBlueprint":
      requireMutableBlueprint(state);
      assert(!state.componentIds.includes(command.componentId), "Blueprint already references that component.");

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
      assert(state.componentIds.includes(command.componentId), "Blueprint does not reference that component.");

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
    case "SetBlueprintProductResolutionRules": {
      requireMutableBlueprint(state);
      const canonicalDimensionOrder = [...command.canonicalDimensionOrder];

      assert(
        hasSameMembers(
          state.dimensionRules.map((rule) => rule.dimensionId),
          canonicalDimensionOrder,
        ),
        "Blueprint product resolution rules must include exactly the current dimensions.",
      );

      return [
        {
          type: "catalog.blueprint.product-resolution-rules-set",
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
      assert(state.status === "active", "Only active blueprints can be deprecated.");

      return [
        {
          type: "catalog.blueprint.deprecated",
          data: EMPTY_EVENT_DATA,
        },
      ];
    case "ArchiveBlueprint":
      requireCreatedBlueprint(state);
      assert(state.status === "deprecated", "Only deprecated blueprints can be archived.");

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

export const evolveBlueprint: AggregateEvolver<BlueprintState, BlueprintEvent> = (state, event) => {
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
        componentIds: toSortedUniqueList([...state.componentIds, event.data.componentId]),
      };
    case "catalog.blueprint.component-detached":
      return {
        ...state,
        componentIds: state.componentIds.filter((componentId) => componentId !== event.data.componentId),
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
        canonicalDimensionOrder: state.canonicalDimensionOrder.filter((dimensionId) =>
          event.data.dimensionRules.some((rule) => rule.dimensionId === dimensionId),
        ),
      };
    case "catalog.blueprint.product-resolution-rules-set":
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
  assert(state.status === "draft", "Only draft blueprints can change identity-bearing structure.");
}

function normalizeFieldRule(rule: BlueprintFieldRule): BlueprintFieldRule {
  return {
    fieldId: rule.fieldId,
    required: rule.required,
  };
}

function normalizeFieldRules(rules: readonly BlueprintFieldRule[]): BlueprintFieldRule[] {
  const normalized = rules.map(normalizeFieldRule);

  ensureUniqueBy(normalized, (rule) => rule.fieldId, "Blueprint field rules must be unique per field.");

  return normalized.sort((left, right) => left.fieldId.localeCompare(right.fieldId));
}

function normalizeDimensionRule(rule: BlueprintDimensionRule): BlueprintDimensionRule {
  const appliesWhen = normalizeDimensionApplicability(rule.dimensionId, rule.appliesWhen);

  return {
    dimensionId: rule.dimensionId,
    required: rule.required,
    allowedOptionIds: toSortedUniqueList(rule.allowedOptionIds),
    appliesWhen,
  };
}

function normalizeDimensionRules(rules: readonly BlueprintDimensionRule[]): BlueprintDimensionRule[] {
  const normalized = rules.map(normalizeDimensionRule);

  ensureUniqueBy(normalized, (rule) => rule.dimensionId, "Blueprint dimension rules must be unique per dimension.");

  return normalized.sort((left, right) => left.dimensionId.localeCompare(right.dimensionId));
}

function normalizeDimensionApplicability(
  dimensionId: DimensionId,
  clauses?: readonly BlueprintDimensionApplicabilityClause[],
): BlueprintDimensionApplicabilityClause[] {
  const normalized = (clauses ?? []).map((clause) => {
    assert(clause.dimensionId !== dimensionId, "Dimension rules cannot depend on their own dimension.");

    return {
      dimensionId: clause.dimensionId,
      optionIds: toSortedUniqueList(clause.optionIds),
    };
  });

  ensureUniqueBy(
    normalized,
    (clause) => clause.dimensionId,
    "Dimension rule applicability must be unique per referenced dimension.",
  );

  return normalized.sort((left, right) => left.dimensionId.localeCompare(right.dimensionId));
}
