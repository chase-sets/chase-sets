import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  ensureUniqueBy,
  localizedTextMapFromEnglish,
  normalizeLocalizedTextMap,
  toSortedUniqueList,
  type CatalogLifecycleStatus,
  type EmptyEventData,
  type LocalizedTextMap,
} from "../../../support/runtime-support/common";
import type { OptionId, ComponentId, DimensionId, FieldId } from "../../../ids";

export type ComponentFieldRule = Readonly<{
  fieldId: FieldId;
  required: boolean;
}>;

export type ComponentDimensionApplicabilityClause = Readonly<{
  dimensionId: DimensionId;
  optionIds: OptionId[];
}>;

export type ComponentDimensionRule = Readonly<{
  dimensionId: DimensionId;
  required: boolean;
  allowedOptionIds: OptionId[];
  appliesWhen?: ComponentDimensionApplicabilityClause[];
}>;

export type ComponentState = Readonly<{
  id: ComponentId | null;
  key: string | null;
  name: LocalizedTextMap | null;
  description: LocalizedTextMap;
  status: CatalogLifecycleStatus;
  fieldRules: ComponentFieldRule[];
  dimensionRules: ComponentDimensionRule[];
}>;

export const initialComponentState: ComponentState = {
  id: null,
  key: null,
  name: null,
  description: localizedTextMapFromEnglish(""),
  status: "draft",
  fieldRules: [],
  dimensionRules: [],
};

export type CreateComponentCommand = Readonly<{
  type: "CreateComponent";
  componentId: ComponentId;
  key: string;
  name: LocalizedTextMap;
  description?: LocalizedTextMap;
}>;

export type AddFieldRuleToComponentCommand = Readonly<{
  type: "AddFieldRuleToComponent";
  fieldId: FieldId;
  required: boolean;
}>;

export type RemoveFieldRuleFromComponentCommand = Readonly<{
  type: "RemoveFieldRuleFromComponent";
  fieldId: FieldId;
}>;

export type AddDimensionRuleToComponentCommand = Readonly<{
  type: "AddDimensionRuleToComponent";
  dimensionId: DimensionId;
  required: boolean;
  allowedOptionIds?: readonly OptionId[];
  appliesWhen?: readonly ComponentDimensionApplicabilityClause[];
}>;

export type RemoveDimensionRuleFromComponentCommand = Readonly<{
  type: "RemoveDimensionRuleFromComponent";
  dimensionId: DimensionId;
}>;

export type ConfigureComponentRulesCommand = Readonly<{
  type: "ConfigureComponentRules";
  key: string;
  name: LocalizedTextMap;
  description?: LocalizedTextMap;
  fieldRules: readonly ComponentFieldRule[];
  dimensionRules: readonly ComponentDimensionRule[];
}>;

export type ActivateComponentCommand = Readonly<{
  type: "ActivateComponent";
}>;

export type DeprecateComponentCommand = Readonly<{
  type: "DeprecateComponent";
}>;

export type ArchiveComponentCommand = Readonly<{
  type: "ArchiveComponent";
}>;

export type ComponentCommand =
  | CreateComponentCommand
  | AddFieldRuleToComponentCommand
  | RemoveFieldRuleFromComponentCommand
  | AddDimensionRuleToComponentCommand
  | RemoveDimensionRuleFromComponentCommand
  | ConfigureComponentRulesCommand
  | ActivateComponentCommand
  | DeprecateComponentCommand
  | ArchiveComponentCommand;

type ComponentRuleSet = Readonly<{
  key: string;
  name: LocalizedTextMap;
  description: LocalizedTextMap;
  fieldRules: ComponentFieldRule[];
  dimensionRules: ComponentDimensionRule[];
}>;

export type ComponentCreatedEvent = DomainEvent<
  "catalog.component.created",
  Readonly<{
    componentId: ComponentId;
    key: string;
    name: LocalizedTextMap;
    description: LocalizedTextMap;
  }>
>;

export type ComponentFieldRuleAddedEvent = DomainEvent<"catalog.component.field-rule-added", ComponentFieldRule>;

export type ComponentFieldRuleRemovedEvent = DomainEvent<
  "catalog.component.field-rule-removed",
  Readonly<{
    fieldId: FieldId;
  }>
>;

export type ComponentDimensionRuleAddedEvent = DomainEvent<
  "catalog.component.dimension-rule-added",
  ComponentDimensionRule
>;

export type ComponentDimensionRuleRemovedEvent = DomainEvent<
  "catalog.component.dimension-rule-removed",
  Readonly<{
    dimensionId: DimensionId;
  }>
>;

export type ComponentRulesConfiguredEvent = DomainEvent<"catalog.component.rules-configured", ComponentRuleSet>;

export type ComponentActivatedEvent = DomainEvent<"catalog.component.activated", EmptyEventData>;

export type ComponentDeprecatedEvent = DomainEvent<"catalog.component.deprecated", EmptyEventData>;

export type ComponentArchivedEvent = DomainEvent<"catalog.component.archived", EmptyEventData>;

export type ComponentEvent =
  | ComponentCreatedEvent
  | ComponentFieldRuleAddedEvent
  | ComponentFieldRuleRemovedEvent
  | ComponentDimensionRuleAddedEvent
  | ComponentDimensionRuleRemovedEvent
  | ComponentRulesConfiguredEvent
  | ComponentActivatedEvent
  | ComponentDeprecatedEvent
  | ComponentArchivedEvent;

export const decideComponent: AggregateDecider<ComponentState, ComponentCommand, ComponentEvent> = (state, command) => {
  switch (command.type) {
    case "CreateComponent":
      assert(state.id === null, "Component has already been created.");

      return [
        {
          type: "catalog.component.created",
          data: {
            componentId: command.componentId,
            key: command.key.trim(),
            name: normalizeLocalizedTextMap(command.name, { requiredEnglish: true }),
            description: command.description
              ? normalizeLocalizedTextMap(command.description)
              : localizedTextMapFromEnglish(""),
          },
        },
      ];
    case "AddFieldRuleToComponent":
      requireMutableComponent(state);
      assert(
        !state.fieldRules.some((rule) => rule.fieldId === command.fieldId),
        "Component already contains that field rule.",
      );

      return [
        {
          type: "catalog.component.field-rule-added",
          data: normalizeFieldRule({
            fieldId: command.fieldId,
            required: command.required,
          }),
        },
      ];
    case "RemoveFieldRuleFromComponent":
      requireMutableComponent(state);
      assert(
        state.fieldRules.some((rule) => rule.fieldId === command.fieldId),
        "Component does not contain that field rule.",
      );

      return [
        {
          type: "catalog.component.field-rule-removed",
          data: {
            fieldId: command.fieldId,
          },
        },
      ];
    case "AddDimensionRuleToComponent":
      requireMutableComponent(state);
      assert(
        !state.dimensionRules.some((rule) => rule.dimensionId === command.dimensionId),
        "Component already contains that dimension rule.",
      );

      return [
        {
          type: "catalog.component.dimension-rule-added",
          data: normalizeDimensionRule({
            dimensionId: command.dimensionId,
            required: command.required,
            allowedOptionIds: [...(command.allowedOptionIds ?? [])],
            appliesWhen: [...(command.appliesWhen ?? [])],
          }),
        },
      ];
    case "RemoveDimensionRuleFromComponent":
      requireMutableComponent(state);
      assert(
        state.dimensionRules.some((rule) => rule.dimensionId === command.dimensionId),
        "Component does not contain that dimension rule.",
      );

      return [
        {
          type: "catalog.component.dimension-rule-removed",
          data: {
            dimensionId: command.dimensionId,
          },
        },
      ];
    case "ConfigureComponentRules":
      requireMutableComponent(state);

      return [
        {
          type: "catalog.component.rules-configured",
          data: {
            key: command.key.trim(),
            name: normalizeLocalizedTextMap(command.name, { requiredEnglish: true }),
            description: command.description ? normalizeLocalizedTextMap(command.description) : state.description,
            fieldRules: normalizeFieldRules(command.fieldRules),
            dimensionRules: normalizeDimensionRules(command.dimensionRules),
          },
        },
      ];
    case "ActivateComponent":
      requireCreatedComponent(state);
      assert(state.status === "draft", "Only draft components can be activated.");

      return [
        {
          type: "catalog.component.activated",
          data: EMPTY_EVENT_DATA,
        },
      ];
    case "DeprecateComponent":
      requireCreatedComponent(state);
      assert(state.status === "active", "Only active components can be deprecated.");

      return [
        {
          type: "catalog.component.deprecated",
          data: EMPTY_EVENT_DATA,
        },
      ];
    case "ArchiveComponent":
      requireCreatedComponent(state);
      assert(state.status === "deprecated", "Only deprecated components can be archived.");

      return [
        {
          type: "catalog.component.archived",
          data: EMPTY_EVENT_DATA,
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveComponent: AggregateEvolver<ComponentState, ComponentEvent> = (state, event) => {
  switch (event.type) {
    case "catalog.component.created":
      return {
        ...state,
        id: event.data.componentId,
        key: event.data.key,
        name: event.data.name,
        description: event.data.description,
        status: "draft",
      };
    case "catalog.component.field-rule-added":
      return {
        ...state,
        fieldRules: normalizeFieldRules([...state.fieldRules, event.data]),
      };
    case "catalog.component.field-rule-removed":
      return {
        ...state,
        fieldRules: state.fieldRules.filter((rule) => rule.fieldId !== event.data.fieldId),
      };
    case "catalog.component.dimension-rule-added":
      return {
        ...state,
        dimensionRules: normalizeDimensionRules([...state.dimensionRules, event.data]),
      };
    case "catalog.component.dimension-rule-removed":
      return {
        ...state,
        dimensionRules: state.dimensionRules.filter((rule) => rule.dimensionId !== event.data.dimensionId),
      };
    case "catalog.component.rules-configured":
      return {
        ...state,
        key: event.data.key,
        name: event.data.name,
        description: event.data.description,
        fieldRules: normalizeFieldRules(event.data.fieldRules),
        dimensionRules: normalizeDimensionRules(event.data.dimensionRules),
      };
    case "catalog.component.activated":
      return {
        ...state,
        status: "active",
      };
    case "catalog.component.deprecated":
      return {
        ...state,
        status: "deprecated",
      };
    case "catalog.component.archived":
      return {
        ...state,
        status: "archived",
      };
    default:
      return assertNever(event);
  }
};

function requireCreatedComponent(state: ComponentState): void {
  assert(state.id !== null, "Component must be created first.");
}

function requireMutableComponent(state: ComponentState): void {
  requireCreatedComponent(state);
  assert(state.status === "draft", "Only draft components can change field or dimension rules.");
}

function normalizeFieldRule(rule: ComponentFieldRule): ComponentFieldRule {
  return {
    fieldId: rule.fieldId,
    required: rule.required,
  };
}

function normalizeFieldRules(rules: readonly ComponentFieldRule[]): ComponentFieldRule[] {
  const normalized = rules.map(normalizeFieldRule);

  ensureUniqueBy(normalized, (rule) => rule.fieldId, "Component field rules must be unique per field.");

  return normalized.sort((left, right) => left.fieldId.localeCompare(right.fieldId));
}

function normalizeDimensionRule(rule: ComponentDimensionRule): ComponentDimensionRule {
  const appliesWhen = normalizeDimensionApplicability(rule.dimensionId, rule.appliesWhen);

  return {
    dimensionId: rule.dimensionId,
    required: rule.required,
    allowedOptionIds: toSortedUniqueList(rule.allowedOptionIds),
    appliesWhen,
  };
}

function normalizeDimensionRules(rules: readonly ComponentDimensionRule[]): ComponentDimensionRule[] {
  const normalized = rules.map(normalizeDimensionRule);

  ensureUniqueBy(normalized, (rule) => rule.dimensionId, "Component dimension rules must be unique per dimension.");

  return normalized.sort((left, right) => left.dimensionId.localeCompare(right.dimensionId));
}

function normalizeDimensionApplicability(
  dimensionId: DimensionId,
  clauses?: readonly ComponentDimensionApplicabilityClause[],
): ComponentDimensionApplicabilityClause[] {
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
