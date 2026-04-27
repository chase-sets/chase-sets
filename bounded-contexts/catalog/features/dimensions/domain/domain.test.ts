import { describe, it, expect } from "vitest";
import {
  decideDimension,
  evolveDimension,
  initialDimensionState,
  type DimensionEvent,
} from "./domain";
import type { OptionId, DimensionId } from "../../../ids";
import { givenEvents, decide, expectDomainError } from "../../../support/authoring-support/test-helpers";

const dimId = "dim_test" as DimensionId;
const optionA = "chc_a" as OptionId;
const optionB = "chc_b" as OptionId;

function createdState() {
  return givenEvents(initialDimensionState, evolveDimension, [
    { type: "catalog.dimension.created", data: { dimensionId: dimId, key: "color", name: "Color", description: "" } },
  ] as DimensionEvent[]);
}

function activeState() {
  return givenEvents(initialDimensionState, evolveDimension, [
    { type: "catalog.dimension.created", data: { dimensionId: dimId, key: "color", name: "Color", description: "" } },
    { type: "catalog.dimension.option-added", data: { optionId: optionA, code: "red", labels: [], displayOrder: 0, numericValue: null, status: "active" } },
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

    it("adds an option", () => {
      const events = decide(decideDimension, createdState(), {
        type: "AddOption" as const,
        optionId: optionA,
        code: "red",
        labels: [{ locale: "en", value: "Red" }],
      });

      expect(events[0].type).toBe("catalog.dimension.option-added");
      expect(events[0].data).toMatchObject({ optionId: optionA, code: "red" });
    });

    it("rejects duplicate option IDs", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        { type: "catalog.dimension.option-added", data: { optionId: optionA, code: "red", labels: [], displayOrder: 0, numericValue: null, status: "active" } },
      ] as DimensionEvent[]);

      expectDomainError(
        () => decide(decideDimension, state, { type: "AddOption" as const, optionId: optionA, code: "blue", labels: [] }),
        "Option already exists on this dimension.",
      );
    });

    it("rejects duplicate option codes", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        { type: "catalog.dimension.option-added", data: { optionId: optionA, code: "red", labels: [], displayOrder: 0, numericValue: null, status: "active" } },
      ] as DimensionEvent[]);

      expectDomainError(
        () => decide(decideDimension, state, { type: "AddOption" as const, optionId: optionB, code: "red", labels: [] }),
        "Option codes must be unique within a dimension.",
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

    it("reorders options", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        { type: "catalog.dimension.option-added", data: { optionId: optionA, code: "red", labels: [], displayOrder: 0, numericValue: null, status: "active" } },
        { type: "catalog.dimension.option-added", data: { optionId: optionB, code: "blue", labels: [], displayOrder: 1, numericValue: null, status: "active" } },
      ] as DimensionEvent[]);

      const events = decide(decideDimension, state, { type: "ReorderOptions" as const, optionIds: [optionB, optionA] });

      expect(events[0].type).toBe("catalog.dimension.options-reordered");
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

    it("evolves option-added event", () => {
      const state = evolveDimension(createdState(), {
        type: "catalog.dimension.option-added",
        data: { optionId: optionA, code: "red", labels: [], displayOrder: 0, numericValue: null, status: "active" },
      } as DimensionEvent);

      expect(state.options).toHaveLength(1);
      expect(state.options[0].id).toBe(optionA);
    });
  });
});
