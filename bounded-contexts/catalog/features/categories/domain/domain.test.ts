import { describe, it, expect } from "vitest";
import {
  decideCategory,
  evolveCategory,
  initialCategoryState,
  type CategoryEvent,
} from "./domain";
import type { CategoryId } from "../../../ids";
import { givenEvents, decide, expectDomainError } from "../../../support/authoring-support/test-helpers";

const catId = "ctg_test" as CategoryId;
const parentId = "ctg_parent" as CategoryId;

function createdState() {
  return givenEvents(initialCategoryState, evolveCategory, [
    { type: "catalog.category.created", data: { categoryId: catId, key: "singles", name: "Singles", description: "", parentCategoryId: null, displayOrder: 0 } },
  ] as CategoryEvent[]);
}

function activeState() {
  return givenEvents(initialCategoryState, evolveCategory, [
    { type: "catalog.category.created", data: { categoryId: catId, key: "singles", name: "Singles", description: "", parentCategoryId: null, displayOrder: 0 } },
    { type: "catalog.category.published", data: {} },
  ] as CategoryEvent[]);
}

describe("Category aggregate", () => {
  describe("decideCategory", () => {
    it("creates a category", () => {
      const events = decide(decideCategory, initialCategoryState, {
        type: "CreateCategory" as const,
        categoryId: catId,
        key: "singles",
        name: "Singles",
      });

      expect(events[0].type).toBe("catalog.category.created");
      expect(events[0].data).toMatchObject({ categoryId: catId, key: "singles" });
    });

    it("creates a category with parent", () => {
      const events = decide(decideCategory, initialCategoryState, {
        type: "CreateCategory" as const,
        categoryId: catId,
        key: "sub",
        name: "Sub",
        parentCategoryId: parentId,
        displayOrder: 5,
      });

      expect(events[0].data).toMatchObject({ parentCategoryId: parentId, displayOrder: 5 });
    });

    it("revises a category", () => {
      const events = decide(decideCategory, createdState(), {
        type: "ReviseCategory" as const,
        key: "singles-v2",
        name: "Singles V2",
      });

      expect(events[0].type).toBe("catalog.category.revised");
    });

    it("publishes a draft category", () => {
      const events = decide(decideCategory, createdState(), { type: "PublishCategory" as const });

      expect(events[0].type).toBe("catalog.category.published");
    });

    it("rejects publishing non-draft", () => {
      expectDomainError(
        () => decide(decideCategory, activeState(), { type: "PublishCategory" as const }),
        "Only draft categories can be published.",
      );
    });

    it("lifecycle: active -> deprecated -> archived", () => {
      const events = decide(decideCategory, activeState(), { type: "DeprecateCategory" as const });

      expect(events[0].type).toBe("catalog.category.deprecated");

      const deprecatedState = givenEvents(activeState(), evolveCategory, [
        { type: "catalog.category.deprecated", data: {} },
      ] as CategoryEvent[]);

      const archiveEvents = decide(decideCategory, deprecatedState, { type: "ArchiveCategory" as const });

      expect(archiveEvents[0].type).toBe("catalog.category.archived");
    });

    it("rejects revising archived categories", () => {
      const archivedState = givenEvents(activeState(), evolveCategory, [
        { type: "catalog.category.deprecated", data: {} },
        { type: "catalog.category.archived", data: {} },
      ] as CategoryEvent[]);

      expectDomainError(
        () => decide(decideCategory, archivedState, { type: "ReviseCategory" as const, key: "x", name: "X" }),
        "Archived categories cannot be revised.",
      );
    });
  });

  describe("evolveCategory", () => {
    it("evolves created event", () => {
      const state = evolveCategory(initialCategoryState, {
        type: "catalog.category.created",
        data: { categoryId: catId, key: "singles", name: "Singles", description: "", parentCategoryId: parentId, displayOrder: 3 },
      });

      expect(state.id).toBe(catId);
      expect(state.parentCategoryId).toBe(parentId);
      expect(state.displayOrder).toBe(3);
    });

    it("evolves revised event", () => {
      const state = evolveCategory(createdState(), {
        type: "catalog.category.revised",
        data: { key: "v2", name: "V2", description: "", parentCategoryId: null, displayOrder: 10 },
      });

      expect(state.key).toBe("v2");
      expect(state.displayOrder).toBe(10);
    });
  });
});
