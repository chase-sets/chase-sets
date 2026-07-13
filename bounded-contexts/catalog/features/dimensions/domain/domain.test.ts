import { describe, it, expect } from "vitest";
import { decideDimension, evolveDimension, initialDimensionState, type DimensionEvent } from "./domain";
import type { OptionId, DimensionId } from "../../../ids";
import { givenEvents, decide, expectDomainError } from "../../../support/authoring-support/test-helpers";
import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";

const dimId = "dim_test" as DimensionId;
const optionA = "chc_a" as OptionId;
const optionB = "chc_b" as OptionId;
const l10n = localizedTextMapFromEnglish;

function createdState() {
  return givenEvents(initialDimensionState, evolveDimension, [
    {
      type: "catalog.dimension.created",
      data: { dimensionId: dimId, key: "color", name: l10n("Color"), description: l10n("") },
    },
  ] as DimensionEvent[]);
}

function activeState() {
  return givenEvents(initialDimensionState, evolveDimension, [
    {
      type: "catalog.dimension.created",
      data: { dimensionId: dimId, key: "color", name: l10n("Color"), description: l10n("") },
    },
    {
      type: "catalog.dimension.option-added",
      data: {
        optionId: optionA,
        code: "red",
        label: l10n("Red"),
        displayOrder: 0,
        numericValue: null,
        status: "active",
      },
    },
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
        name: l10n("Color"),
      });

      expect(events).toEqual([
        {
          type: "catalog.dimension.created",
          data: {
            dimensionId: dimId,
            key: "color",
            name: l10n("Color"),
            description: l10n(""),
            valueKind: "unordered",
          },
        },
      ]);
    });

    it("creates an ordered dimension", () => {
      const events = decide(decideDimension, initialDimensionState, {
        type: "CreateDimension" as const,
        dimensionId: dimId,
        key: "condition",
        name: l10n("Condition"),
        valueKind: "ordered",
      });

      expect(events[0].data).toMatchObject({ valueKind: "ordered" });
    });

    it("rejects creating a dimension twice", () => {
      expectDomainError(
        () =>
          decide(decideDimension, createdState(), {
            type: "CreateDimension" as const,
            dimensionId: "dim_other" as DimensionId,
            key: "size",
            name: l10n("Size"),
          }),
        "Dimension has already been created.",
      );
    });

    it("revises a dimension", () => {
      const events = decide(decideDimension, createdState(), {
        type: "ReviseDimension" as const,
        key: "colour",
        name: l10n("Colour"),
      });

      expect(events[0].type).toBe("catalog.dimension.revised");
    });

    it("revises dimension value kind when active options have numeric values", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        {
          type: "catalog.dimension.option-added",
          data: {
            optionId: optionA,
            code: "red",
            label: l10n("Red"),
            displayOrder: 0,
            numericValue: 1,
            status: "active",
          },
        },
      ] as DimensionEvent[]);

      const events = decide(decideDimension, state, {
        type: "ReviseDimension" as const,
        key: "score",
        name: l10n("Score"),
        valueKind: "numeric",
      });

      expect(events[0].data).toMatchObject({ valueKind: "numeric" });
    });

    it("rejects numeric dimensions with active options missing numeric values", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        {
          type: "catalog.dimension.option-added",
          data: {
            optionId: optionA,
            code: "red",
            label: l10n("Red"),
            displayOrder: 0,
            numericValue: null,
            status: "active",
          },
        },
      ] as DimensionEvent[]);

      expectDomainError(
        () =>
          decide(decideDimension, state, {
            type: "ReviseDimension" as const,
            key: "score",
            name: l10n("Score"),
            valueKind: "numeric",
          }),
        "Numeric dimensions require numeric values for active options.",
      );
    });

    it("adds an option", () => {
      const events = decide(decideDimension, createdState(), {
        type: "AddOption" as const,
        optionId: optionA,
        code: "red",
        label: l10n("Red"),
      });

      expect(events[0].type).toBe("catalog.dimension.option-added");
      expect(events[0].data).toMatchObject({ optionId: optionA, code: "red", numericValue: null });
    });

    it("preserves option numeric values", () => {
      const events = decide(decideDimension, createdState(), {
        type: "AddOption" as const,
        optionId: optionA,
        code: "red",
        label: l10n("Red"),
        numericValue: 7,
      });

      expect(events[0].data).toMatchObject({ optionId: optionA, numericValue: 7 });
    });

    it("rejects duplicate option IDs", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        {
          type: "catalog.dimension.option-added",
          data: {
            optionId: optionA,
            code: "red",
            label: l10n("Red"),
            displayOrder: 0,
            numericValue: null,
            status: "active",
          },
        },
      ] as DimensionEvent[]);

      expectDomainError(
        () =>
          decide(decideDimension, state, {
            type: "AddOption" as const,
            optionId: optionA,
            code: "blue",
            label: l10n("Blue"),
          }),
        "Option already exists on this dimension.",
      );
    });

    it("rejects duplicate option codes", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        {
          type: "catalog.dimension.option-added",
          data: {
            optionId: optionA,
            code: "red",
            label: l10n("Red"),
            displayOrder: 0,
            numericValue: null,
            status: "active",
          },
        },
      ] as DimensionEvent[]);

      expectDomainError(
        () =>
          decide(decideDimension, state, {
            type: "AddOption" as const,
            optionId: optionB,
            code: "red",
            label: l10n("Red"),
          }),
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
        () => decide(decideDimension, archivedState, { type: "ReviseDimension" as const, key: "x", name: l10n("X") }),
        "Archived dimensions cannot be revised.",
      );
    });

    it("reorders options", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        {
          type: "catalog.dimension.option-added",
          data: {
            optionId: optionA,
            code: "red",
            label: l10n("Red"),
            displayOrder: 0,
            numericValue: null,
            status: "active",
          },
        },
        {
          type: "catalog.dimension.option-added",
          data: {
            optionId: optionB,
            code: "blue",
            label: l10n("Blue"),
            displayOrder: 1,
            numericValue: null,
            status: "active",
          },
        },
      ] as DimensionEvent[]);

      const events = decide(decideDimension, state, { type: "ReorderOptions" as const, optionIds: [optionB, optionA] });

      expect(events[0].type).toBe("catalog.dimension.options-reordered");
    });

    it("rejects reordering with a mismatched option set", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        {
          type: "catalog.dimension.option-added",
          data: {
            optionId: optionA,
            code: "red",
            label: l10n("Red"),
            displayOrder: 0,
            numericValue: null,
            status: "active",
          },
        },
      ] as DimensionEvent[]);

      expectDomainError(
        () => decide(decideDimension, state, { type: "ReorderOptions" as const, optionIds: [optionA, optionB] }),
        "Reordered options must include exactly the current set of options.",
      );
    });

    it("revises an option", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        {
          type: "catalog.dimension.option-added",
          data: {
            optionId: optionA,
            code: "red",
            label: l10n("Red"),
            displayOrder: 0,
            numericValue: null,
            status: "active",
          },
        },
      ] as DimensionEvent[]);

      const events = decide(decideDimension, state, {
        type: "ReviseOption" as const,
        optionId: optionA,
        code: "crimson",
        label: l10n("Crimson"),
      });

      expect(events[0].type).toBe("catalog.dimension.option-revised");
      expect(events[0].data).toMatchObject({ optionId: optionA, code: "crimson" });
    });

    it("rejects revising an option to a code already used by another option", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        {
          type: "catalog.dimension.option-added",
          data: {
            optionId: optionA,
            code: "red",
            label: l10n("Red"),
            displayOrder: 0,
            numericValue: null,
            status: "active",
          },
        },
        {
          type: "catalog.dimension.option-added",
          data: {
            optionId: optionB,
            code: "blue",
            label: l10n("Blue"),
            displayOrder: 1,
            numericValue: null,
            status: "active",
          },
        },
      ] as DimensionEvent[]);

      expectDomainError(
        () =>
          decide(decideDimension, state, {
            type: "ReviseOption" as const,
            optionId: optionA,
            code: "blue",
            label: l10n("Blue-ish"),
          }),
        "Option codes must remain unique within a dimension.",
      );
    });

    it("rejects revising an option that does not exist", () => {
      expectDomainError(
        () =>
          decide(decideDimension, createdState(), {
            type: "ReviseOption" as const,
            optionId: optionA,
            code: "red",
            label: l10n("Red"),
          }),
        "Option does not exist on this dimension.",
      );
    });

    it("deprecates an option", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        {
          type: "catalog.dimension.option-added",
          data: {
            optionId: optionA,
            code: "red",
            label: l10n("Red"),
            displayOrder: 0,
            numericValue: null,
            status: "active",
          },
        },
      ] as DimensionEvent[]);

      const events = decide(decideDimension, state, { type: "DeprecateOption" as const, optionId: optionA });

      expect(events[0]).toEqual({
        type: "catalog.dimension.option-deprecated",
        data: { optionId: optionA },
      });
    });

    it("rejects deprecating an option that does not exist", () => {
      expectDomainError(
        () => decide(decideDimension, createdState(), { type: "DeprecateOption" as const, optionId: optionA }),
        "Option does not exist on this dimension.",
      );
    });

    it("reactivates a deprecated option", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        {
          type: "catalog.dimension.option-added",
          data: {
            optionId: optionA,
            code: "red",
            label: l10n("Red"),
            displayOrder: 0,
            numericValue: null,
            status: "active",
          },
        },
        { type: "catalog.dimension.option-deprecated", data: { optionId: optionA } },
      ] as DimensionEvent[]);

      const events = decide(decideDimension, state, { type: "ReactivateOption" as const, optionId: optionA });

      expect(events[0]).toEqual({
        type: "catalog.dimension.option-reactivated",
        data: { optionId: optionA },
      });
    });

    it("rejects reactivating a numeric option missing its numeric value", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        {
          type: "catalog.dimension.revised",
          data: { key: "score", name: l10n("Score"), description: l10n(""), valueKind: "numeric" },
        },
        {
          type: "catalog.dimension.option-added",
          data: {
            optionId: optionA,
            code: "low",
            label: l10n("Low"),
            displayOrder: 0,
            numericValue: null,
            status: "deprecated",
          },
        },
      ] as DimensionEvent[]);

      expectDomainError(
        () => decide(decideDimension, state, { type: "ReactivateOption" as const, optionId: optionA }),
        "Numeric dimensions require numeric values for options.",
      );
    });

    it("rejects modifications to options on archived dimensions", () => {
      const archivedState = givenEvents(activeState(), evolveDimension, [
        { type: "catalog.dimension.deprecated", data: {} },
        { type: "catalog.dimension.archived", data: {} },
      ] as DimensionEvent[]);

      expectDomainError(
        () =>
          decide(decideDimension, archivedState, {
            type: "AddOption" as const,
            optionId: optionB,
            code: "blue",
            label: l10n("Blue"),
          }),
        "Archived dimensions cannot add options.",
      );
    });
  });

  describe("evolveDimension", () => {
    it("evolves created event", () => {
      const state = evolveDimension(initialDimensionState, {
        type: "catalog.dimension.created",
        data: { dimensionId: dimId, key: "color", name: l10n("Color"), description: l10n("") },
      });

      expect(state.id).toBe(dimId);
      expect(state.key).toBe("color");
      expect(state.name).toEqual(l10n("Color"));
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
        data: {
          optionId: optionA,
          code: "red",
          label: l10n("Red"),
          displayOrder: 0,
          numericValue: null,
          status: "active",
        },
      } as DimensionEvent);

      expect(state.options).toHaveLength(1);
      expect(state.options[0].id).toBe(optionA);
    });
  });
});
