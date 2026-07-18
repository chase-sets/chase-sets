import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  localizedTextMapFromEnglish,
  normalizeLocalizedTextMap,
  toSortedUniqueList,
  type CatalogLifecycleStatus,
  type EmptyEventData,
  type LocalizedTextMap,
} from "../../../support/runtime-support/common";
import type { DisplayTemplateId } from "../../../ids";

export type DisplayTemplateTargetKind = "global" | "blueprint" | "category" | "reference-record" | "catalog-item";

export type DisplayTemplateTarget = Readonly<{
  kind: DisplayTemplateTargetKind;
  id?: string;
}>;

export type DisplayTemplateState = Readonly<{
  id: DisplayTemplateId | null;
  key: string | null;
  name: LocalizedTextMap | null;
  description: LocalizedTextMap;
  target: DisplayTemplateTarget;
  priority: number;
  titleTemplate: string;
  subtitleTemplate: string | null;
  requiredFieldKeys: readonly string[];
  status: CatalogLifecycleStatus;
}>;

export const initialDisplayTemplateState: DisplayTemplateState = {
  id: null,
  key: null,
  name: null,
  description: localizedTextMapFromEnglish(""),
  target: { kind: "global" },
  priority: 0,
  titleTemplate: "",
  subtitleTemplate: null,
  requiredFieldKeys: [],
  status: "draft",
};

type DisplayTemplateConfiguration = Readonly<{
  key: string;
  name: LocalizedTextMap;
  description: LocalizedTextMap;
  target: DisplayTemplateTarget;
  priority: number;
  titleTemplate: string;
  subtitleTemplate: string | null;
  requiredFieldKeys: readonly string[];
}>;

export type CreateDisplayTemplateCommand = Readonly<{
  type: "CreateDisplayTemplate";
  displayTemplateId: DisplayTemplateId;
}> &
  Omit<DisplayTemplateConfiguration, "description" | "requiredFieldKeys"> &
  Partial<Pick<DisplayTemplateConfiguration, "description">>;

export type ReviseDisplayTemplateCommand = Readonly<{
  type: "ReviseDisplayTemplate";
}> &
  Omit<DisplayTemplateConfiguration, "description" | "requiredFieldKeys"> &
  Partial<Pick<DisplayTemplateConfiguration, "description">>;

export type PublishDisplayTemplateCommand = Readonly<{ type: "PublishDisplayTemplate" }>;
export type DeprecateDisplayTemplateCommand = Readonly<{ type: "DeprecateDisplayTemplate" }>;
export type ArchiveDisplayTemplateCommand = Readonly<{ type: "ArchiveDisplayTemplate" }>;

export type DisplayTemplateCommand =
  | CreateDisplayTemplateCommand
  | ReviseDisplayTemplateCommand
  | PublishDisplayTemplateCommand
  | DeprecateDisplayTemplateCommand
  | ArchiveDisplayTemplateCommand;

export type DisplayTemplateCreatedEvent = DomainEvent<
  "catalog.display-template.created",
  Readonly<{ displayTemplateId: DisplayTemplateId }> & DisplayTemplateConfiguration
>;
export type DisplayTemplateRevisedEvent = DomainEvent<"catalog.display-template.revised", DisplayTemplateConfiguration>;
export type DisplayTemplatePublishedEvent = DomainEvent<"catalog.display-template.published", EmptyEventData>;
export type DisplayTemplateDeprecatedEvent = DomainEvent<"catalog.display-template.deprecated", EmptyEventData>;
export type DisplayTemplateArchivedEvent = DomainEvent<"catalog.display-template.archived", EmptyEventData>;

export type DisplayTemplateEvent =
  | DisplayTemplateCreatedEvent
  | DisplayTemplateRevisedEvent
  | DisplayTemplatePublishedEvent
  | DisplayTemplateDeprecatedEvent
  | DisplayTemplateArchivedEvent;

export const decideDisplayTemplate: AggregateDecider<
  DisplayTemplateState,
  DisplayTemplateCommand,
  DisplayTemplateEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateDisplayTemplate":
      assert(state.id === null, "Display Template has already been created.");

      return [
        {
          type: "catalog.display-template.created",
          data: {
            displayTemplateId: command.displayTemplateId,
            ...normalizeConfiguration(command),
          },
        },
      ];
    case "ReviseDisplayTemplate":
      requireCreatedDisplayTemplate(state);
      assert(state.status !== "archived", "Archived Display Templates cannot be revised.");

      return [
        {
          type: "catalog.display-template.revised",
          data: normalizeConfiguration({
            ...command,
            description: command.description ?? state.description,
          }),
        },
      ];
    case "PublishDisplayTemplate":
      requireCreatedDisplayTemplate(state);
      assert(state.status === "draft", "Only draft Display Templates can be published.");
      return [{ type: "catalog.display-template.published", data: EMPTY_EVENT_DATA }];
    case "DeprecateDisplayTemplate":
      requireCreatedDisplayTemplate(state);
      assert(state.status === "active", "Only active Display Templates can be deprecated.");
      return [{ type: "catalog.display-template.deprecated", data: EMPTY_EVENT_DATA }];
    case "ArchiveDisplayTemplate":
      requireCreatedDisplayTemplate(state);
      assert(state.status === "deprecated", "Only deprecated Display Templates can be archived.");
      return [{ type: "catalog.display-template.archived", data: EMPTY_EVENT_DATA }];
    default:
      return assertNever(command);
  }
};

export const evolveDisplayTemplate: AggregateEvolver<DisplayTemplateState, DisplayTemplateEvent> = (state, event) => {
  switch (event.type) {
    case "catalog.display-template.created":
      return {
        ...state,
        id: event.data.displayTemplateId,
        key: event.data.key,
        name: event.data.name,
        description: event.data.description,
        target: event.data.target,
        priority: event.data.priority,
        titleTemplate: event.data.titleTemplate,
        subtitleTemplate: event.data.subtitleTemplate,
        requiredFieldKeys: event.data.requiredFieldKeys,
        status: "draft",
      };
    case "catalog.display-template.revised":
      return {
        ...state,
        key: event.data.key,
        name: event.data.name,
        description: event.data.description,
        target: event.data.target,
        priority: event.data.priority,
        titleTemplate: event.data.titleTemplate,
        subtitleTemplate: event.data.subtitleTemplate,
        requiredFieldKeys: event.data.requiredFieldKeys,
      };
    case "catalog.display-template.published":
      return { ...state, status: "active" };
    case "catalog.display-template.deprecated":
      return { ...state, status: "deprecated" };
    case "catalog.display-template.archived":
      return { ...state, status: "archived" };
    default:
      return assertNever(event);
  }
};

function requireCreatedDisplayTemplate(state: DisplayTemplateState): void {
  assert(state.id !== null, "Display Template must be created first.");
}

function normalizeConfiguration(
  command: Omit<CreateDisplayTemplateCommand | ReviseDisplayTemplateCommand, "displayTemplateId">,
): DisplayTemplateConfiguration {
  const titleTemplate = command.titleTemplate.trim();

  assert(titleTemplate.length > 0, "Display Templates require a title template.");

  return {
    key: normalizeKey(command.key),
    name: normalizeLocalizedTextMap(command.name, { requiredEnglish: true }),
    description: command.description ? normalizeLocalizedTextMap(command.description) : localizedTextMapFromEnglish(""),
    target: normalizeTarget(command.target),
    priority: Number.isFinite(command.priority) ? Math.trunc(command.priority) : 0,
    titleTemplate,
    subtitleTemplate: command.subtitleTemplate?.trim() || null,
    requiredFieldKeys: deriveRequiredFieldKeys(titleTemplate, command.subtitleTemplate?.trim() || null),
  };
}

/** Required fields are derived from non-optional field and reference tokens. */
export function deriveRequiredFieldKeys(titleTemplate: string, subtitleTemplate: string | null): readonly string[] {
  return toSortedUniqueList(
    [titleTemplate, subtitleTemplate ?? ""].flatMap((template) =>
      displayTemplateTokens(removeOptionalSegments(template)).flatMap((token) => {
        const [kind, key] = token.split(".");
        return (kind === "field" || kind === "reference") && key ? [normalizeKey(key)] : [];
      }),
    ),
  );
}

export function displayTemplateTokens(template: string): readonly string[] {
  return [...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1].trim()).filter(Boolean);
}

export function titleHasNonOptionalContent(titleTemplate: string): boolean {
  return removeOptionalSegments(titleTemplate).trim().length > 0;
}

function removeOptionalSegments(template: string): string {
  let result = template;
  let previous: string | undefined;
  while (result !== previous) {
    previous = result;
    result = result.replace(/\[[^\[\]]*\]/g, "");
  }
  return result;
}

function normalizeTarget(target: DisplayTemplateTarget): DisplayTemplateTarget {
  assert(
    target.kind === "global" ||
      target.kind === "blueprint" ||
      target.kind === "category" ||
      target.kind === "reference-record" ||
      target.kind === "catalog-item",
    "Display Template target kind is invalid.",
  );

  if (target.kind === "global") {
    return { kind: "global" };
  }

  const id = target.id?.trim() ?? "";
  assert(id.length > 0, "Scoped Display Templates require a target ID.");
  return { kind: target.kind, id };
}

function normalizeKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  assert(normalized.length > 0, "Display Template keys are required.");
  return normalized;
}
