import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  ensureUniqueBy,
  type CatalogItemStatus,
  type CatalogValue,
  type EmptyEventData,
} from "../../../support/runtime-support/common";
import type { BlueprintId, CategoryId, FieldId, CatalogItemId } from "../../../ids";

export type ItemFieldValue = Readonly<{
  fieldId: FieldId;
  value: CatalogValue;
}>;

export type CatalogItemState = Readonly<{
  id: CatalogItemId | null;
  title: string | null;
  subtitle: string | null;
  description: string;
  blueprintId: BlueprintId | null;
  status: CatalogItemStatus;
  fieldValues: readonly ItemFieldValue[];
  categoryIds: readonly CategoryId[];
  tags: readonly string[];
  imageUrls: readonly string[];
}>;

export const initialCatalogItemState: CatalogItemState = {
  id: null,
  title: null,
  subtitle: null,
  description: "",
  blueprintId: null,
  status: "draft",
  fieldValues: [],
  categoryIds: [],
  tags: [],
  imageUrls: [],
};

export type CreateItemCommand = Readonly<{
  type: "CreateItem";
  itemId: CatalogItemId;
  title: string;
  subtitle?: string | null;
  description?: string;
}>;

export type AssignBlueprintToItemCommand = Readonly<{
  type: "AssignBlueprintToItem";
  blueprintId: BlueprintId;
}>;

export type SetItemFieldValueCommand = Readonly<{
  type: "SetItemFieldValue";
  fieldId: FieldId;
  value: CatalogValue;
}>;

export type ClearItemFieldValueCommand = Readonly<{
  type: "ClearItemFieldValue";
  fieldId: FieldId;
  requiredFieldIds?: readonly FieldId[];
}>;

export type AssignItemToCategoryCommand = Readonly<{
  type: "AssignItemToCategory";
  categoryId: CategoryId;
}>;

export type RemoveItemFromCategoryCommand = Readonly<{
  type: "RemoveItemFromCategory";
  categoryId: CategoryId;
}>;

export type PublishItemCommand = Readonly<{
  type: "PublishItem";
  blueprintIsActive: boolean;
  requiredFieldIds: readonly FieldId[];
}>;

export type ReviseItemMetadataCommand = Readonly<{
  type: "ReviseItemMetadata";
  title: string;
  subtitle?: string | null;
  description?: string;
}>;

export type SetItemTagsCommand = Readonly<{
  type: "SetItemTags";
  tags: readonly string[];
}>;

export type SetItemImageUrlsCommand = Readonly<{
  type: "SetItemImageUrls";
  imageUrls: readonly string[];
}>;

export type RetireItemCommand = Readonly<{
  type: "RetireItem";
}>;

export type ArchiveItemCommand = Readonly<{
  type: "ArchiveItem";
}>;

export type CatalogItemCommand =
  | CreateItemCommand
  | AssignBlueprintToItemCommand
  | SetItemFieldValueCommand
  | ClearItemFieldValueCommand
  | AssignItemToCategoryCommand
  | RemoveItemFromCategoryCommand
  | PublishItemCommand
  | ReviseItemMetadataCommand
  | SetItemTagsCommand
  | SetItemImageUrlsCommand
  | RetireItemCommand
  | ArchiveItemCommand;

type ItemMetadata = Readonly<{
  title: string;
  subtitle: string | null;
  description: string;
}>;

export type ItemCreatedEvent = DomainEvent<
  "catalog.catalog-item.created",
  Readonly<{
    itemId: CatalogItemId;
  }> &
    ItemMetadata
>;

export type ItemBlueprintAssignedEvent = DomainEvent<
  "catalog.catalog-item.blueprint-assigned",
  Readonly<{
    blueprintId: BlueprintId;
  }>
>;

export type ItemFieldValueSetEvent = DomainEvent<
  "catalog.catalog-item.field-value-set",
  ItemFieldValue
>;

export type ItemFieldValueClearedEvent = DomainEvent<
  "catalog.catalog-item.field-value-cleared",
  Readonly<{
    fieldId: FieldId;
  }>
>;

export type ItemCategoryAssignedEvent = DomainEvent<
  "catalog.catalog-item.category-assigned",
  Readonly<{
    categoryId: CategoryId;
  }>
>;

export type ItemCategoryRemovedEvent = DomainEvent<
  "catalog.catalog-item.category-removed",
  Readonly<{
    categoryId: CategoryId;
  }>
>;

export type ItemPublishedEvent = DomainEvent<
  "catalog.catalog-item.published",
  Readonly<{
    blueprintId: BlueprintId;
  }>
>;

export type ItemMetadataRevisedEvent = DomainEvent<
  "catalog.catalog-item.metadata-revised",
  ItemMetadata
>;

export type ItemTagsSetEvent = DomainEvent<
  "catalog.catalog-item.tags-set",
  Readonly<{
    tags: string[];
  }>
>;

export type ItemImageUrlsSetEvent = DomainEvent<
  "catalog.catalog-item.image-urls-set",
  Readonly<{
    imageUrls: string[];
  }>
>;

export type ItemRetiredEvent = DomainEvent<
  "catalog.catalog-item.retired",
  EmptyEventData
>;

export type ItemArchivedEvent = DomainEvent<
  "catalog.catalog-item.archived",
  EmptyEventData
>;

export type CatalogItemEvent =
  | ItemCreatedEvent
  | ItemBlueprintAssignedEvent
  | ItemFieldValueSetEvent
  | ItemFieldValueClearedEvent
  | ItemCategoryAssignedEvent
  | ItemCategoryRemovedEvent
  | ItemPublishedEvent
  | ItemMetadataRevisedEvent
  | ItemTagsSetEvent
  | ItemImageUrlsSetEvent
  | ItemRetiredEvent
  | ItemArchivedEvent;

export const decideCatalogItem: AggregateDecider<
  CatalogItemState,
  CatalogItemCommand,
  CatalogItemEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateItem":
      assert(state.id === null, "Catalog item has already been created.");

      return [
        {
          type: "catalog.catalog-item.created",
          data: {
            itemId: command.itemId,
            title: command.title.trim(),
            subtitle: command.subtitle?.trim() ?? null,
            description: command.description?.trim() ?? "",
          },
        },
      ];
    case "AssignBlueprintToItem":
      requireCreatedItem(state);
      assert(state.status === "draft", "Blueprint may only be assigned while draft.");

      return [
        {
          type: "catalog.catalog-item.blueprint-assigned",
          data: {
            blueprintId: command.blueprintId,
          },
        },
      ];
    case "SetItemFieldValue":
      requireCreatedItem(state);
      assert(state.status !== "archived", "Archived items cannot be modified.");

      return [
        {
          type: "catalog.catalog-item.field-value-set",
          data: {
            fieldId: command.fieldId,
            value: command.value,
          },
        },
      ];
    case "ClearItemFieldValue":
      requireCreatedItem(state);
      assert(state.status !== "archived", "Archived items cannot be modified.");
      assert(
        state.fieldValues.some((fieldValue) => fieldValue.fieldId === command.fieldId),
        "The item does not contain that field value.",
      );

      if (state.status === "active") {
        assert(
          command.requiredFieldIds !== undefined,
          "Active items require required field context to clear a field value.",
        );
        assert(
          !command.requiredFieldIds.includes(command.fieldId),
          "Required field values cannot be cleared from active items.",
        );
      }

      return [
        {
          type: "catalog.catalog-item.field-value-cleared",
          data: {
            fieldId: command.fieldId,
          },
        },
      ];
    case "AssignItemToCategory":
      requireCreatedItem(state);
      assert(state.status !== "archived", "Archived items cannot be modified.");
      assert(
        !state.categoryIds.includes(command.categoryId),
        "Item already belongs to that category.",
      );

      return [
        {
          type: "catalog.catalog-item.category-assigned",
          data: {
            categoryId: command.categoryId,
          },
        },
      ];
    case "RemoveItemFromCategory":
      requireCreatedItem(state);
      assert(state.status !== "archived", "Archived items cannot be modified.");
      assert(
        state.categoryIds.includes(command.categoryId),
        "Item does not belong to that category.",
      );

      return [
        {
          type: "catalog.catalog-item.category-removed",
          data: {
            categoryId: command.categoryId,
          },
        },
      ];
    case "PublishItem": {
      requireCreatedItem(state);
      assert(state.status === "draft", "Only draft items can be published.");
      assert(state.blueprintId !== null, "Items require a blueprint before publish.");
      assert(
        command.blueprintIsActive,
        "Items may only publish against active blueprints.",
      );

      const requiredFieldIds = normalizeRequiredFieldIds(command.requiredFieldIds);
      const populatedFieldIds = new Set(
        state.fieldValues.map((fieldValue) => fieldValue.fieldId),
      );

      for (const requiredFieldId of requiredFieldIds) {
        assert(
          populatedFieldIds.has(requiredFieldId),
          "Items must satisfy all required field rules before publish.",
        );
      }

      return [
        {
          type: "catalog.catalog-item.published",
          data: {
            blueprintId: state.blueprintId,
          },
        },
      ];
    }
    case "ReviseItemMetadata":
      requireCreatedItem(state);
      assert(state.status !== "archived", "Archived items cannot be revised.");

      return [
        {
          type: "catalog.catalog-item.metadata-revised",
          data: {
            title: command.title.trim(),
            subtitle: command.subtitle?.trim() ?? null,
            description: command.description?.trim() ?? state.description,
          },
        },
      ];
    case "SetItemTags":
      requireCreatedItem(state);
      assert(state.status !== "archived", "Archived items cannot be modified.");

      return [
        {
          type: "catalog.catalog-item.tags-set",
          data: {
            tags: normalizeTags(command.tags),
          },
        },
      ];
    case "SetItemImageUrls":
      requireCreatedItem(state);
      assert(state.status !== "archived", "Archived items cannot be modified.");

      return [
        {
          type: "catalog.catalog-item.image-urls-set",
          data: {
            imageUrls: [...command.imageUrls],
          },
        },
      ];
    case "RetireItem":
      requireCreatedItem(state);
      assert(state.status === "active", "Only active items can be retired.");

      return [
        {
          type: "catalog.catalog-item.retired",
          data: EMPTY_EVENT_DATA,
        },
      ];
    case "ArchiveItem":
      requireCreatedItem(state);
      assert(state.status === "retired", "Only retired items can be archived.");

      return [
        {
          type: "catalog.catalog-item.archived",
          data: EMPTY_EVENT_DATA,
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveCatalogItem: AggregateEvolver<
  CatalogItemState,
  CatalogItemEvent
> = (state, event) => {
  switch (event.type) {
    case "catalog.catalog-item.created":
      return {
        ...state,
        id: event.data.itemId,
        title: event.data.title,
        subtitle: event.data.subtitle,
        description: event.data.description,
        status: "draft",
      };
    case "catalog.catalog-item.blueprint-assigned":
      return {
        ...state,
        blueprintId: event.data.blueprintId,
      };
    case "catalog.catalog-item.field-value-set":
      return {
        ...state,
        fieldValues: normalizeFieldValues([
          ...state.fieldValues.filter(
            (fieldValue) => fieldValue.fieldId !== event.data.fieldId,
          ),
          event.data,
        ]),
      };
    case "catalog.catalog-item.field-value-cleared":
      return {
        ...state,
        fieldValues: state.fieldValues.filter(
          (fieldValue) => fieldValue.fieldId !== event.data.fieldId,
        ),
      };
    case "catalog.catalog-item.category-assigned":
      return {
        ...state,
        categoryIds: [...state.categoryIds, event.data.categoryId].sort((left, right) =>
          left.localeCompare(right),
        ),
      };
    case "catalog.catalog-item.category-removed":
      return {
        ...state,
        categoryIds: state.categoryIds.filter(
          (categoryId) => categoryId !== event.data.categoryId,
        ),
      };
    case "catalog.catalog-item.published":
      return {
        ...state,
        blueprintId: event.data.blueprintId,
        status: "active",
      };
    case "catalog.catalog-item.metadata-revised":
      return {
        ...state,
        title: event.data.title,
        subtitle: event.data.subtitle,
        description: event.data.description,
      };
    case "catalog.catalog-item.tags-set":
      return {
        ...state,
        tags: event.data.tags,
      };
    case "catalog.catalog-item.image-urls-set":
      return {
        ...state,
        imageUrls: event.data.imageUrls,
      };
    case "catalog.catalog-item.retired":
      return {
        ...state,
        status: "retired",
      };
    case "catalog.catalog-item.archived":
      return {
        ...state,
        status: "archived",
      };
    default:
      return assertNever(event);
  }
};

function requireCreatedItem(state: CatalogItemState): void {
  assert(state.id !== null, "Catalog item must be created first.");
}

function normalizeFieldValues(
  fieldValues: readonly ItemFieldValue[],
): readonly ItemFieldValue[] {
  ensureUniqueBy(
    fieldValues,
    (fieldValue) => fieldValue.fieldId,
    "Catalog items may only hold one value per field.",
  );

  return [...fieldValues].sort((left, right) =>
    left.fieldId.localeCompare(right.fieldId),
  );
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function normalizeRequiredFieldIds(
  fieldIds: readonly FieldId[],
): readonly FieldId[] {
  const normalized = [...new Set(fieldIds)].sort((left, right) =>
    left.localeCompare(right),
  );

  ensureUniqueBy(
    normalized.map((fieldId) => ({ fieldId })),
    (entry) => entry.fieldId,
    "Required field IDs must be unique.",
  );

  return normalized;
}


