import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  localizedTextMapFromEnglish,
  normalizeLocalizedTextMap,
  toSortedUniqueList,
  type CatalogLifecycleStatus,
  type CatalogValue,
  type EmptyEventData,
  type LocalizedTextMap,
} from "../../../support/runtime-support/common";
import type { ReferenceRecordId, ReferenceTypeId } from "../../../ids";

export type ReferenceRelationship = Readonly<{
  relationshipType: string;
  referenceId: ReferenceRecordId;
}>;

export type ReferenceTypeState = Readonly<{
  id: ReferenceTypeId | null;
  key: string | null;
  name: LocalizedTextMap | null;
  description: LocalizedTextMap;
  status: CatalogLifecycleStatus;
  attributeKeys: readonly string[];
}>;

export const initialReferenceTypeState: ReferenceTypeState = {
  id: null,
  key: null,
  name: null,
  description: localizedTextMapFromEnglish(""),
  status: "draft",
  attributeKeys: [],
};

export type ReferenceRecordState = Readonly<{
  id: ReferenceRecordId | null;
  typeKey: string | null;
  key: string | null;
  name: LocalizedTextMap | null;
  description: LocalizedTextMap;
  attributes: Readonly<Record<string, CatalogValue>>;
  relationships: readonly ReferenceRelationship[];
  status: CatalogLifecycleStatus;
}>;

export const initialReferenceRecordState: ReferenceRecordState = {
  id: null,
  typeKey: null,
  key: null,
  name: null,
  description: localizedTextMapFromEnglish(""),
  attributes: {},
  relationships: [],
  status: "draft",
};

export type CreateReferenceTypeCommand = Readonly<{
  type: "CreateReferenceType";
  referenceTypeId: ReferenceTypeId;
  key: string;
  name: LocalizedTextMap;
  description?: LocalizedTextMap;
  attributeKeys?: readonly string[];
}>;

export type ReviseReferenceTypeCommand = Readonly<{
  type: "ReviseReferenceType";
  key: string;
  name: LocalizedTextMap;
  description?: LocalizedTextMap;
  attributeKeys?: readonly string[];
}>;

export type PublishReferenceTypeCommand = Readonly<{
  type: "PublishReferenceType";
}>;

export type DeprecateReferenceTypeCommand = Readonly<{
  type: "DeprecateReferenceType";
}>;

export type ArchiveReferenceTypeCommand = Readonly<{
  type: "ArchiveReferenceType";
}>;

export type ReferenceTypeCommand =
  | CreateReferenceTypeCommand
  | ReviseReferenceTypeCommand
  | PublishReferenceTypeCommand
  | DeprecateReferenceTypeCommand
  | ArchiveReferenceTypeCommand;

type ReferenceTypeSnapshot = Readonly<{
  key: string;
  name: LocalizedTextMap;
  description: LocalizedTextMap;
  attributeKeys: readonly string[];
}>;

export type ReferenceTypeCreatedEvent = DomainEvent<
  "catalog.reference-type.created",
  Readonly<{ referenceTypeId: ReferenceTypeId }> & ReferenceTypeSnapshot
>;

export type ReferenceTypeRevisedEvent = DomainEvent<
  "catalog.reference-type.revised",
  ReferenceTypeSnapshot
>;

export type ReferenceTypePublishedEvent = DomainEvent<
  "catalog.reference-type.published",
  EmptyEventData
>;

export type ReferenceTypeDeprecatedEvent = DomainEvent<
  "catalog.reference-type.deprecated",
  EmptyEventData
>;

export type ReferenceTypeArchivedEvent = DomainEvent<
  "catalog.reference-type.archived",
  EmptyEventData
>;

export type ReferenceTypeEvent =
  | ReferenceTypeCreatedEvent
  | ReferenceTypeRevisedEvent
  | ReferenceTypePublishedEvent
  | ReferenceTypeDeprecatedEvent
  | ReferenceTypeArchivedEvent;

export type CreateReferenceRecordCommand = Readonly<{
  type: "CreateReferenceRecord";
  referenceRecordId: ReferenceRecordId;
  typeKey: string;
  key: string;
  name: LocalizedTextMap;
  description?: LocalizedTextMap;
  attributes?: Readonly<Record<string, CatalogValue>>;
  relationships?: readonly ReferenceRelationship[];
}>;

export type ReviseReferenceRecordCommand = Readonly<{
  type: "ReviseReferenceRecord";
  typeKey: string;
  key: string;
  name: LocalizedTextMap;
  description?: LocalizedTextMap;
  attributes?: Readonly<Record<string, CatalogValue>>;
  relationships?: readonly ReferenceRelationship[];
}>;

export type PublishReferenceRecordCommand = Readonly<{
  type: "PublishReferenceRecord";
}>;

export type DeprecateReferenceRecordCommand = Readonly<{
  type: "DeprecateReferenceRecord";
}>;

export type ArchiveReferenceRecordCommand = Readonly<{
  type: "ArchiveReferenceRecord";
}>;

export type ReferenceRecordCommand =
  | CreateReferenceRecordCommand
  | ReviseReferenceRecordCommand
  | PublishReferenceRecordCommand
  | DeprecateReferenceRecordCommand
  | ArchiveReferenceRecordCommand;

type ReferenceRecordSnapshot = Readonly<{
  typeKey: string;
  key: string;
  name: LocalizedTextMap;
  description: LocalizedTextMap;
  attributes: Readonly<Record<string, CatalogValue>>;
  relationships: readonly ReferenceRelationship[];
}>;

export type ReferenceRecordCreatedEvent = DomainEvent<
  "catalog.reference-record.created",
  Readonly<{ referenceRecordId: ReferenceRecordId }> & ReferenceRecordSnapshot
>;

export type ReferenceRecordRevisedEvent = DomainEvent<
  "catalog.reference-record.revised",
  ReferenceRecordSnapshot
>;

export type ReferenceRecordPublishedEvent = DomainEvent<
  "catalog.reference-record.published",
  EmptyEventData
>;

export type ReferenceRecordDeprecatedEvent = DomainEvent<
  "catalog.reference-record.deprecated",
  EmptyEventData
>;

export type ReferenceRecordArchivedEvent = DomainEvent<
  "catalog.reference-record.archived",
  EmptyEventData
>;

export type ReferenceRecordEvent =
  | ReferenceRecordCreatedEvent
  | ReferenceRecordRevisedEvent
  | ReferenceRecordPublishedEvent
  | ReferenceRecordDeprecatedEvent
  | ReferenceRecordArchivedEvent;

export const decideReferenceType: AggregateDecider<
  ReferenceTypeState,
  ReferenceTypeCommand,
  ReferenceTypeEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateReferenceType":
      assert(state.id === null, "Reference type has already been created.");

      return [
        {
          type: "catalog.reference-type.created",
          data: {
            referenceTypeId: command.referenceTypeId,
            key: normalizeKey(command.key),
            name: normalizeLocalizedTextMap(command.name, { requiredEnglish: true }),
            description: command.description
              ? normalizeLocalizedTextMap(command.description)
              : localizedTextMapFromEnglish(""),
            attributeKeys: normalizeAttributeKeys(command.attributeKeys ?? []),
          },
        },
      ];
    case "ReviseReferenceType":
      requireCreatedReferenceType(state);
      assert(state.status !== "archived", "Archived reference types cannot be revised.");

      return [
        {
          type: "catalog.reference-type.revised",
          data: {
            key: normalizeKey(command.key),
            name: normalizeLocalizedTextMap(command.name, { requiredEnglish: true }),
            description: command.description
              ? normalizeLocalizedTextMap(command.description)
              : state.description,
            attributeKeys: normalizeAttributeKeys(command.attributeKeys ?? state.attributeKeys),
          },
        },
      ];
    case "PublishReferenceType":
      requireCreatedReferenceType(state);
      assert(state.status === "draft", "Only draft reference types can be published.");

      return [{ type: "catalog.reference-type.published", data: EMPTY_EVENT_DATA }];
    case "DeprecateReferenceType":
      requireCreatedReferenceType(state);
      assert(state.status === "active", "Only active reference types can be deprecated.");

      return [{ type: "catalog.reference-type.deprecated", data: EMPTY_EVENT_DATA }];
    case "ArchiveReferenceType":
      requireCreatedReferenceType(state);
      assert(state.status === "deprecated", "Only deprecated reference types can be archived.");

      return [{ type: "catalog.reference-type.archived", data: EMPTY_EVENT_DATA }];
    default:
      return assertNever(command);
  }
};

export const evolveReferenceType: AggregateEvolver<ReferenceTypeState, ReferenceTypeEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "catalog.reference-type.created":
      return {
        ...state,
        id: event.data.referenceTypeId,
        key: event.data.key,
        name: event.data.name,
        description: event.data.description,
        attributeKeys: event.data.attributeKeys,
        status: "draft",
      };
    case "catalog.reference-type.revised":
      return {
        ...state,
        key: event.data.key,
        name: event.data.name,
        description: event.data.description,
        attributeKeys: event.data.attributeKeys,
      };
    case "catalog.reference-type.published":
      return { ...state, status: "active" };
    case "catalog.reference-type.deprecated":
      return { ...state, status: "deprecated" };
    case "catalog.reference-type.archived":
      return { ...state, status: "archived" };
    default:
      return assertNever(event);
  }
};

export const decideReferenceRecord: AggregateDecider<
  ReferenceRecordState,
  ReferenceRecordCommand,
  ReferenceRecordEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateReferenceRecord":
      assert(state.id === null, "Reference record has already been created.");

      return [
        {
          type: "catalog.reference-record.created",
          data: {
            referenceRecordId: command.referenceRecordId,
            typeKey: normalizeKey(command.typeKey),
            key: normalizeKey(command.key),
            name: normalizeLocalizedTextMap(command.name, { requiredEnglish: true }),
            description: command.description
              ? normalizeLocalizedTextMap(command.description)
              : localizedTextMapFromEnglish(""),
            attributes: normalizeAttributes(command.attributes ?? {}),
            relationships: normalizeRelationships(command.relationships ?? []),
          },
        },
      ];
    case "ReviseReferenceRecord":
      requireCreatedReferenceRecord(state);
      assert(state.status !== "archived", "Archived reference records cannot be revised.");

      return [
        {
          type: "catalog.reference-record.revised",
          data: {
            typeKey: normalizeKey(command.typeKey),
            key: normalizeKey(command.key),
            name: normalizeLocalizedTextMap(command.name, { requiredEnglish: true }),
            description: command.description
              ? normalizeLocalizedTextMap(command.description)
              : state.description,
            attributes: normalizeAttributes(command.attributes ?? state.attributes),
            relationships: normalizeRelationships(command.relationships ?? state.relationships),
          },
        },
      ];
    case "PublishReferenceRecord":
      requireCreatedReferenceRecord(state);
      assert(state.status === "draft", "Only draft reference records can be published.");

      return [{ type: "catalog.reference-record.published", data: EMPTY_EVENT_DATA }];
    case "DeprecateReferenceRecord":
      requireCreatedReferenceRecord(state);
      assert(state.status === "active", "Only active reference records can be deprecated.");

      return [{ type: "catalog.reference-record.deprecated", data: EMPTY_EVENT_DATA }];
    case "ArchiveReferenceRecord":
      requireCreatedReferenceRecord(state);
      assert(state.status === "deprecated", "Only deprecated reference records can be archived.");

      return [{ type: "catalog.reference-record.archived", data: EMPTY_EVENT_DATA }];
    default:
      return assertNever(command);
  }
};

export const evolveReferenceRecord: AggregateEvolver<
  ReferenceRecordState,
  ReferenceRecordEvent
> = (state, event) => {
  switch (event.type) {
    case "catalog.reference-record.created":
      return {
        ...state,
        id: event.data.referenceRecordId,
        typeKey: event.data.typeKey,
        key: event.data.key,
        name: event.data.name,
        description: event.data.description,
        attributes: event.data.attributes,
        relationships: event.data.relationships,
        status: "draft",
      };
    case "catalog.reference-record.revised":
      return {
        ...state,
        typeKey: event.data.typeKey,
        key: event.data.key,
        name: event.data.name,
        description: event.data.description,
        attributes: event.data.attributes,
        relationships: event.data.relationships,
      };
    case "catalog.reference-record.published":
      return { ...state, status: "active" };
    case "catalog.reference-record.deprecated":
      return { ...state, status: "deprecated" };
    case "catalog.reference-record.archived":
      return { ...state, status: "archived" };
    default:
      return assertNever(event);
  }
};

function requireCreatedReferenceType(state: ReferenceTypeState): void {
  assert(state.id !== null, "Reference type must be created first.");
}

function requireCreatedReferenceRecord(state: ReferenceRecordState): void {
  assert(state.id !== null, "Reference record must be created first.");
}

function normalizeKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  assert(normalized.length > 0, "Reference keys are required.");
  return normalized;
}

function normalizeAttributeKeys(attributeKeys: readonly string[]): readonly string[] {
  return toSortedUniqueList(attributeKeys.map((key) => normalizeKey(key)));
}

function normalizeAttributes(
  attributes: Readonly<Record<string, CatalogValue>>,
): Readonly<Record<string, CatalogValue>> {
  return Object.fromEntries(
    Object.entries(attributes)
      .map(([key, value]) => [normalizeKey(key), value] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeRelationships(
  relationships: readonly ReferenceRelationship[],
): readonly ReferenceRelationship[] {
  const normalized = relationships
    .map((relationship) => ({
      relationshipType: normalizeKey(relationship.relationshipType),
      referenceId: relationship.referenceId,
    }))
    .sort((left, right) =>
      left.relationshipType === right.relationshipType
        ? left.referenceId.localeCompare(right.referenceId)
        : left.relationshipType.localeCompare(right.relationshipType),
    );

  const keys = new Set<string>();
  for (const relationship of normalized) {
    const key = `${relationship.relationshipType}:${relationship.referenceId}`;
    assert(!keys.has(key), "Reference relationships must be unique.");
    keys.add(key);
  }

  return normalized;
}
