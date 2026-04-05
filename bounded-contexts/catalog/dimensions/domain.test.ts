import { describe, it, expect } from "vitest";
import {
  decideDimension,
  evolveDimension,
  initialDimensionState,
  type DimensionEvent,
} from "./domain";
import type { ChoiceId, DimensionId } from "../ids";
import { givenEvents, decide, expectDomainError } from "../test-support/domain-test-helpers";

const dimId = "dim_test" as DimensionId;
const choiceA = "chc_a" as ChoiceId;
const choiceB = "chc_b" as ChoiceId;

function createdState() {
  return givenEvents(initialDimensionState, evolveDimension, [
    { type: "catalog.dimension.created", data: { dimensionId: dimId, key: "color", name: "Color", description: "" } },
  ] as DimensionEvent[]);
}

function activeState() {
  return givenEvents(initialDimensionState, evolveDimension, [
    { type: "catalog.dimension.created", data: { dimensionId: dimId, key: "color", name: "Color", description: "" } },
    { type: "catalog.dimension.choice-added", data: { choiceId: choiceA, code: "red", labels: [], displayOrder: 0, numericValue: null, status: "active" } },
    { type: "catalog.dimension.activated", data: {} },
  ] as DimensionEvent[]);
}

describe("Dimension aggregate", () => {
  describe("decideDimension", () => {
    it("creates a dimension", () => {
      const events = decide(decideDimension, initialDimensionState, {
        type: "CreateDimension" as const,
        dimensionId: dimId,
        key: "color",
        name: "Color",
      });

      expect(events).toEqual([
        { type: "catalog.dimension.created", data: { dimensionId: dimId, key: "color", name: "Color", description: "" } },
      ]);
    });

    it("rejects creating a dimension twice", () => {
      expectDomainError(
        () => decide(decideDimension, createdState(), { type: "CreateDimension" as const, dimensionId: "dim_other" as DimensionId, key: "size", name: "Size" }),
        "Dimension has already been created.",
      );
    });

    it("revises a dimension", () => {
      const events = decide(decideDimension, createdState(), { type: "ReviseDimension" as const, key: "colour", name: "Colour" });

      expect(events[0].type).toBe("catalog.dimension.revised");
    });

    it("adds a choice", () => {
      const events = decide(decideDimension, createdState(), {
        type: "AddChoice" as const,
        choiceId: choiceA,
        code: "red",
        labels: [{ locale: "en", value: "Red" }],
      });

      expect(events[0].type).toBe("catalog.dimension.choice-added");
      expect(events[0].data).toMatchObject({ choiceId: choiceA, code: "red" });
    });

    it("rejects duplicate choice IDs", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        { type: "catalog.dimension.choice-added", data: { choiceId: choiceA, code: "red", labels: [], displayOrder: 0, numericValue: null, status: "active" } },
      ] as DimensionEvent[]);

      expectDomainError(
        () => decide(decideDimension, state, { type: "AddChoice" as const, choiceId: choiceA, code: "blue", labels: [] }),
        "Choice already exists on this dimension.",
      );
    });

    it("rejects duplicate choice codes", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        { type: "catalog.dimension.choice-added", data: { choiceId: choiceA, code: "red", labels: [], displayOrder: 0, numericValue: null, status: "active" } },
      ] as DimensionEvent[]);

      expectDomainError(
        () => decide(decideDimension, state, { type: "AddChoice" as const, choiceId: choiceB, code: "red", labels: [] }),
        "Choice codes must be unique within a dimension.",
      );
    });

    it("activates a draft dimension", () => {
      const events = decide(decideDimension, createdState(), { type: "ActivateDimension" as const });

      expect(events[0].type).toBe("catalog.dimension.activated");
    });

    it("rejects activating non-draft dimension", () => {
      expectDomainError(
        () => decide(decideDimension, activeState(), { type: "ActivateDimension" as const }),
        "Only draft dimensions can be activated.",
      );
    });

    it("deprecates an active dimension", () => {
      const events = decide(decideDimension, activeState(), { type: "DeprecateDimension" as const });

      expect(events[0].type).toBe("catalog.dimension.deprecated");
    });

    it("rejects deprecating non-active dimension", () => {
      expectDomainError(
        () => decide(decideDimension, createdState(), { type: "DeprecateDimension" as const }),
        "Only active dimensions can be deprecated.",
      );
    });

    it("archives a deprecated dimension", () => {
      const deprecatedState = givenEvents(activeState(), evolveDimension, [
        { type: "catalog.dimension.deprecated", data: {} },
      ] as DimensionEvent[]);

      const events = decide(decideDimension, deprecatedState, { type: "ArchiveDimension" as const });

      expect(events[0].type).toBe("catalog.dimension.archived");
    });

    it("rejects modifications to archived dimensions", () => {
      const archivedState = givenEvents(activeState(), evolveDimension, [
        { type: "catalog.dimension.deprecated", data: {} },
        { type: "catalog.dimension.archived", data: {} },
      ] as DimensionEvent[]);

      expectDomainError(
        () => decide(decideDimension, archivedState, { type: "ReviseDimension" as const, key: "x", name: "X" }),
        "Archived dimensions cannot be revised.",
      );
    });

    it("reorders choices", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        { type: "catalog.dimension.choice-added", data: { choiceId: choiceA, code: "red", labels: [], displayOrder: 0, numericValue: null, status: "active" } },
        { type: "catalog.dimension.choice-added", data: { choiceId: choiceB, code: "blue", labels: [], displayOrder: 1, numericValue: null, status: "active" } },
      ] as DimensionEvent[]);

      const events = decide(decideDimension, state, { type: "ReorderChoices" as const, choiceIds: [choiceB, choiceA] });

      expect(events[0].type).toBe("catalog.dimension.choices-reordered");
    });
  });

  describe("evolveDimension", () => {
    it("evolves created event", () => {
      const state = evolveDimension(initialDimensionState, {
        type: "catalog.dimension.created",
        data: { dimensionId: dimId, key: "color", name: "Color", description: "" },
      });

      expect(state.id).toBe(dimId);
      expect(state.key).toBe("color");
      expect(state.name).toBe("Color");
      expect(state.status).toBe("draft");
    });

    it("evolves activated event", () => {
      const state = evolveDimension(createdState(), {
        type: "catalog.dimension.activated",
        data: {},
      } as DimensionEvent);

      expect(state.status).toBe("active");
    });

    it("evolves choice-added event", () => {
      const state = evolveDimension(createdState(), {
        type: "catalog.dimension.choice-added",
        data: { choiceId: choiceA, code: "red", labels: [], displayOrder: 0, numericValue: null, status: "active" },
      } as DimensionEvent);

      expect(state.choices).toHaveLength(1);
      expect(state.choices[0].id).toBe(choiceA);
    });
  });
});

