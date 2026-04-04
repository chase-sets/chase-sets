import { assert } from "./common";
import type { DomainEvent } from "@chase-sets/event-core";
import type { CatalogItemStatus, CatalogValue } from "./common";
import type {
  CatalogVersionDescriptor,
  CatalogVersionSchema,
} from "./versioning";
import type { CatalogItemId } from "./ids";

export type CatalogItemFieldValueSnapshot = Readonly<{
  fieldId: string;
  value: CatalogValue;
}>;

export type CatalogItemSnapshot = Readonly<{
  catalogItemId: CatalogItemId;
  status: CatalogItemStatus;
  title: string;
  subtitle: string | null;
  blueprintId: string | null;
  fieldValues: CatalogItemFieldValueSnapshot[];
  categoryIds: string[];
  versionSchema: CatalogVersionSchema;
  sampleVersions?: CatalogVersionDescriptor[];
}>;

export type CatalogItemPublishedIntegrationEvent = DomainEvent<
  "CatalogItemPublished",
  CatalogItemSnapshot
>;

export type CatalogItemUpdatedIntegrationEvent = DomainEvent<
  "CatalogItemUpdated",
  CatalogItemSnapshot
>;

export type CatalogItemRetiredIntegrationEvent = DomainEvent<
  "CatalogItemRetired",
  CatalogItemSnapshot
>;

export type CatalogItemArchivedIntegrationEvent = DomainEvent<
  "CatalogItemArchived",
  CatalogItemSnapshot
>;

export type CatalogIntegrationEvent =
  | CatalogItemPublishedIntegrationEvent
  | CatalogItemUpdatedIntegrationEvent
  | CatalogItemRetiredIntegrationEvent
  | CatalogItemArchivedIntegrationEvent;

export function createCatalogItemSnapshot(input: {
  item: Readonly<{
    id: CatalogItemId | null;
    status: CatalogItemStatus;
    title: string | null;
    subtitle: string | null;
    blueprintId: string | null;
    fieldValues: readonly Readonly<{
      fieldId: string;
      value: CatalogValue;
    }>[];
    categoryIds: readonly string[];
  }>;
  versionSchema: CatalogVersionSchema;
  sampleVersions?: readonly CatalogVersionDescriptor[];
}): CatalogItemSnapshot {
  const { item } = input;

  assert(item.id !== null, "Catalog item must be created before it can be shared.");
  assert(item.title !== null, "Catalog item title must exist before it can be shared.");

  return {
    catalogItemId: item.id,
    status: item.status,
    title: item.title,
    subtitle: item.subtitle,
    blueprintId: item.blueprintId === null ? null : String(item.blueprintId),
    fieldValues: item.fieldValues.map((fieldValue) => ({
      fieldId: String(fieldValue.fieldId),
      value: fieldValue.value,
    })),
    categoryIds: item.categoryIds.map((categoryId) => String(categoryId)),
    versionSchema: input.versionSchema,
    sampleVersions:
      input.sampleVersions === undefined ? undefined : [...input.sampleVersions],
  };
}

export function createCatalogItemPublishedEvent(
  snapshot: CatalogItemSnapshot,
): CatalogItemPublishedIntegrationEvent {
  return {
    type: "CatalogItemPublished",
    data: snapshot,
  };
}

export function createCatalogItemUpdatedEvent(
  snapshot: CatalogItemSnapshot,
): CatalogItemUpdatedIntegrationEvent {
  return {
    type: "CatalogItemUpdated",
    data: snapshot,
  };
}

export function createCatalogItemRetiredEvent(
  snapshot: CatalogItemSnapshot,
): CatalogItemRetiredIntegrationEvent {
  return {
    type: "CatalogItemRetired",
    data: snapshot,
  };
}

export function createCatalogItemArchivedEvent(
  snapshot: CatalogItemSnapshot,
): CatalogItemArchivedIntegrationEvent {
  return {
    type: "CatalogItemArchived",
    data: snapshot,
  };
}

export * from "./sellable-units";

