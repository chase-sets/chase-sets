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
} from "./common";
import type { CategoryId } from "./ids";

export type CategoryState = Readonly<{
  id: CategoryId | null;
  key: string | null;
  name: string | null;
  status: CatalogLifecycleStatus;
  parentCategoryId: CategoryId | null;
  displayOrder: number;
}>;

export const initialCategoryState: CategoryState = {
  id: null,
  key: null,
  name: null,
  status: "draft",
  parentCategoryId: null,
  displayOrder: 0,
};

export type CreateCategoryCommand = Readonly<{
  type: "CreateCategory";
  categoryId: CategoryId;
  key: string;
  name: string;
  parentCategoryId?: CategoryId | null;
  displayOrder?: number;
}>;

export type ReviseCategoryCommand = Readonly<{
  type: "ReviseCategory";
  key: string;
  name: string;
  parentCategoryId?: CategoryId | null;
  displayOrder?: number;
}>;

export type PublishCategoryCommand = Readonly<{
  type: "PublishCategory";
}>;

export type DeprecateCategoryCommand = Readonly<{
  type: "DeprecateCategory";
}>;

export type ArchiveCategoryCommand = Readonly<{
  type: "ArchiveCategory";
}>;

export type CategoryCommand =
  | CreateCategoryCommand
  | ReviseCategoryCommand
  | PublishCategoryCommand
  | DeprecateCategoryCommand
  | ArchiveCategoryCommand;

type CategorySnapshot = Readonly<{
  key: string;
  name: string;
  parentCategoryId: CategoryId | null;
  displayOrder: number;
}>;

export type CategoryCreatedEvent = DomainEvent<
  "catalog.category.created",
  Readonly<{
    categoryId: CategoryId;
  }> &
    CategorySnapshot
>;

export type CategoryRevisedEvent = DomainEvent<
  "catalog.category.revised",
  CategorySnapshot
>;

export type CategoryPublishedEvent = DomainEvent<
  "catalog.category.published",
  EmptyEventData
>;

export type CategoryDeprecatedEvent = DomainEvent<
  "catalog.category.deprecated",
  EmptyEventData
>;

export type CategoryArchivedEvent = DomainEvent<
  "catalog.category.archived",
  EmptyEventData
>;

export type CategoryEvent =
  | CategoryCreatedEvent
  | CategoryRevisedEvent
  | CategoryPublishedEvent
  | CategoryDeprecatedEvent
  | CategoryArchivedEvent;

export const decideCategory: AggregateDecider<
  CategoryState,
  CategoryCommand,
  CategoryEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateCategory":
      assert(state.id === null, "Category has already been created.");

      return [
        {
          type: "catalog.category.created",
          data: {
            categoryId: command.categoryId,
            key: command.key.trim(),
            name: command.name.trim(),
            parentCategoryId: command.parentCategoryId ?? null,
            displayOrder: command.displayOrder ?? 0,
          },
        },
      ];
    case "ReviseCategory":
      requireCreatedCategory(state);
      assert(state.status !== "archived", "Archived categories cannot be revised.");

      return [
        {
          type: "catalog.category.revised",
          data: {
            key: command.key.trim(),
            name: command.name.trim(),
            parentCategoryId: command.parentCategoryId ?? null,
            displayOrder: command.displayOrder ?? state.displayOrder,
          },
        },
      ];
    case "PublishCategory":
      requireCreatedCategory(state);
      assert(state.status === "draft", "Only draft categories can be published.");

      return [
        {
          type: "catalog.category.published",
          data: EMPTY_EVENT_DATA,
        },
      ];
    case "DeprecateCategory":
      requireCreatedCategory(state);
      assert(
        state.status === "active",
        "Only active categories can be deprecated.",
      );

      return [
        {
          type: "catalog.category.deprecated",
          data: EMPTY_EVENT_DATA,
        },
      ];
    case "ArchiveCategory":
      requireCreatedCategory(state);
      assert(
        state.status === "deprecated",
        "Only deprecated categories can be archived.",
      );

      return [
        {
          type: "catalog.category.archived",
          data: EMPTY_EVENT_DATA,
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveCategory: AggregateEvolver<CategoryState, CategoryEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "catalog.category.created":
      return {
        ...state,
        id: event.data.categoryId,
        key: event.data.key,
        name: event.data.name,
        status: "draft",
        parentCategoryId: event.data.parentCategoryId,
        displayOrder: event.data.displayOrder,
      };
    case "catalog.category.revised":
      return {
        ...state,
        key: event.data.key,
        name: event.data.name,
        parentCategoryId: event.data.parentCategoryId,
        displayOrder: event.data.displayOrder,
      };
    case "catalog.category.published":
      return {
        ...state,
        status: "active",
      };
    case "catalog.category.deprecated":
      return {
        ...state,
        status: "deprecated",
      };
    case "catalog.category.archived":
      return {
        ...state,
        status: "archived",
      };
    default:
      return assertNever(event);
  }
};

function requireCreatedCategory(state: CategoryState): void {
  assert(state.id !== null, "Category must be created first.");
}
