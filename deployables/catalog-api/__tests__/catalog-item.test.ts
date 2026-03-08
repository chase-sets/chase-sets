import { describe, it, expect } from "vitest";
import {
  decideCatalogItem,
  evolveCatalogItem,
  initialCatalogItemState,
  type CatalogItemEvent,
} from "../../../bounded-contexts/catalog/catalog-item";
import type { CatalogItemId, BlueprintId, FieldId, CategoryId } from "../../../bounded-contexts/catalog/ids";
import { givenEvents, decide, expectDomainError } from "./helpers";

const itemId = "cat_test_item" as CatalogItemId;
const bpId = "bpr_test" as BlueprintId;
const fieldA = "fld_a" as FieldId;
const fieldB = "fld_b" as FieldId;
const catA = "ctg_a" as CategoryId;
const catB = "ctg_b" as CategoryId;

function createdState() {
  return givenEvents(initialCatalogItemState, evolveCatalogItem, [
    { type: "catalog.catalog-item.created", data: { itemId, title: "Test Card", subtitle: null, description: "" } },
  ] as CatalogItemEvent[]);
}

function draftWithBlueprint() {
  return givenEvents(initialCatalogItemState, evolveCatalogItem, [
    { type: "catalog.catalog-item.created", data: { itemId, title: "Test Card", subtitle: null, description: "" } },
    { type: "catalog.catalog-item.blueprint-assigned", data: { blueprintId: bpId } },
    { type: "catalog.catalog-item.field-value-set", data: { fieldId: fieldA, value: "Red" } },
  ] as CatalogItemEvent[]);
}

function activeState() {
  return givenEvents(initialCatalogItemState, evolveCatalogItem, [
    { type: "catalog.catalog-item.created", data: { itemId, title: "Test Card", subtitle: null, description: "" } },
    { type: "catalog.catalog-item.blueprint-assigned", data: { blueprintId: bpId } },
    { type: "catalog.catalog-item.field-value-set", data: { fieldId: fieldA, value: "Red" } },
    { type: "catalog.catalog-item.published", data: { blueprintId: bpId } },
  ] as CatalogItemEvent[]);
}

describe("CatalogItem aggregate", () => {
  describe("decideCatalogItem", () => {
    it("creates an item", () => {
      const events = decide(decideCatalogItem, initialCatalogItemState, {
        type: "CreateItem" as const,
        itemId,
        title: "Test Card",
        subtitle: "Subtitle",
      });

      expect(events[0].type).toBe("catalog.catalog-item.created");
      expect(events[0].data).toMatchObject({ itemId, title: "Test Card", subtitle: "Subtitle" });
    });

    it("rejects creating twice", () => {
      expectDomainError(
        () => decide(decideCatalogItem, createdState(), { type: "CreateItem" as const, itemId: "other" as CatalogItemId, title: "X" }),
        "Catalog item has already been created.",
      );
    });

    it("assigns a blueprint while draft", () => {
      const events = decide(decideCatalogItem, createdState(), {
        type: "AssignBlueprintToItem" as const,
        blueprintId: bpId,
      });

      expect(events[0].type).toBe("catalog.catalog-item.blueprint-assigned");
    });

    it("rejects blueprint assignment after publish", () => {
      expectDomainError(
        () => decide(decideCatalogItem, activeState(), { type: "AssignBlueprintToItem" as const, blueprintId: "bpr_other" as BlueprintId }),
        "Blueprint may only be assigned while draft.",
      );
    });

    it("sets a field value", () => {
      const events = decide(decideCatalogItem, createdState(), {
        type: "SetItemFieldValue" as const,
        fieldId: fieldA,
        value: "Red",
      });

      expect(events[0].type).toBe("catalog.catalog-item.field-value-set");
    });

    it("clears a field value", () => {
      const state = givenEvents(createdState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.field-value-set", data: { fieldId: fieldA, value: "Red" } },
      ] as CatalogItemEvent[]);

      const events = decide(decideCatalogItem, state, { type: "ClearItemFieldValue" as const, fieldId: fieldA });

      expect(events[0].type).toBe("catalog.catalog-item.field-value-cleared");
    });

    it("rejects clearing a non-existent field value", () => {
      expectDomainError(
        () => decide(decideCatalogItem, createdState(), { type: "ClearItemFieldValue" as const, fieldId: fieldA }),
        "The item does not contain that field value.",
      );
    });

    it("assigns item to category", () => {
      const events = decide(decideCatalogItem, createdState(), {
        type: "AssignItemToCategory" as const,
        categoryId: catA,
      });

      expect(events[0].type).toBe("catalog.catalog-item.category-assigned");
    });

    it("rejects duplicate category assignment", () => {
      const state = givenEvents(createdState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.category-assigned", data: { categoryId: catA } },
      ] as CatalogItemEvent[]);

      expectDomainError(
        () => decide(decideCatalogItem, state, { type: "AssignItemToCategory" as const, categoryId: catA }),
        "Item already belongs to that category.",
      );
    });

    it("publishes a draft item with all required fields", () => {
      const events = decide(decideCatalogItem, draftWithBlueprint(), {
        type: "PublishItem" as const,
        blueprintIsActive: true,
        requiredFieldIds: [fieldA],
      });

      expect(events[0].type).toBe("catalog.catalog-item.published");
    });

    it("rejects publish without blueprint", () => {
      expectDomainError(
        () => decide(decideCatalogItem, createdState(), { type: "PublishItem" as const, blueprintIsActive: true, requiredFieldIds: [] }),
        "Items require a blueprint before publish.",
      );
    });

    it("rejects publish when blueprint is not active", () => {
      const state = givenEvents(createdState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.blueprint-assigned", data: { blueprintId: bpId } },
      ] as CatalogItemEvent[]);

      expectDomainError(
        () => decide(decideCatalogItem, state, { type: "PublishItem" as const, blueprintIsActive: false, requiredFieldIds: [] }),
        "Items may only publish against active blueprints.",
      );
    });

    it("rejects publish when required fields are missing", () => {
      const state = givenEvents(createdState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.blueprint-assigned", data: { blueprintId: bpId } },
      ] as CatalogItemEvent[]);

      expectDomainError(
        () => decide(decideCatalogItem, state, { type: "PublishItem" as const, blueprintIsActive: true, requiredFieldIds: [fieldA] }),
        "Items must satisfy all required field rules before publish.",
      );
    });

    it("revises metadata on active item", () => {
      const events = decide(decideCatalogItem, activeState(), {
        type: "ReviseItemMetadata" as const,
        title: "Updated Title",
        subtitle: "New Sub",
      });

      expect(events[0].type).toBe("catalog.catalog-item.metadata-revised");
    });

    it("lifecycle: active -> retired -> archived", () => {
      const events = decide(decideCatalogItem, activeState(), { type: "RetireItem" as const });

      expect(events[0].type).toBe("catalog.catalog-item.retired");

      const retiredState = givenEvents(activeState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.retired", data: {} },
      ] as CatalogItemEvent[]);

      const archiveEvents = decide(decideCatalogItem, retiredState, { type: "ArchiveItem" as const });

      expect(archiveEvents[0].type).toBe("catalog.catalog-item.archived");
    });

    it("rejects modifications to archived items", () => {
      const archivedState = givenEvents(activeState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.retired", data: {} },
        { type: "catalog.catalog-item.archived", data: {} },
      ] as CatalogItemEvent[]);

      expectDomainError(
        () => decide(decideCatalogItem, archivedState, { type: "SetItemFieldValue" as const, fieldId: fieldB, value: "x" }),
        "Archived items cannot be modified.",
      );
    });
  });

  describe("evolveCatalogItem", () => {
    it("evolves created event", () => {
      const state = evolveCatalogItem(initialCatalogItemState, {
        type: "catalog.catalog-item.created",
        data: { itemId, title: "Test", subtitle: "Sub", description: "" },
      });

      expect(state.id).toBe(itemId);
      expect(state.title).toBe("Test");
      expect(state.subtitle).toBe("Sub");
      expect(state.status).toBe("draft");
    });

    it("evolves field value set replaces existing", () => {
      const state = givenEvents(createdState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.field-value-set", data: { fieldId: fieldA, value: "Red" } },
        { type: "catalog.catalog-item.field-value-set", data: { fieldId: fieldA, value: "Blue" } },
      ] as CatalogItemEvent[]);

      expect(state.fieldValues).toHaveLength(1);
      expect(state.fieldValues[0].value).toBe("Blue");
    });

    it("evolves category assigned sorts alphabetically", () => {
      const state = givenEvents(createdState(), evolveCatalogItem, [
        { type: "catalog.catalog-item.category-assigned", data: { categoryId: catB } },
        { type: "catalog.catalog-item.category-assigned", data: { categoryId: catA } },
      ] as CatalogItemEvent[]);

      expect(state.categoryIds).toEqual([catA, catB]);
    });

    it("evolves published event", () => {
      const state = evolveCatalogItem(draftWithBlueprint(), {
        type: "catalog.catalog-item.published",
        data: { blueprintId: bpId },
      });

      expect(state.status).toBe("active");
    });
  });
});
