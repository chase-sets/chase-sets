import { describe, it, expect } from "vitest";
import { decideDimension, evolveDimension, initialDimensionState, type DimensionEvent } from "./domain";
import type { OptionId, DimensionId } from "../../../ids";
import { givenEvents, decide, expectDomainError } from "../../../support/authoring-support/test-helpers";
import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";

const dimId = "dim_test" as DimensionId;
const optionA = "chc_a" as OptionId;
const optionB = "chc_b" as OptionId;
const optionC = "chc_c" as OptionId;
const reorderError = "Reordered options must include exactly the current set of options.";
const l10n = localizedTextMapFromEnglish;

function createdState() {
  return givenEvents(initialDimensionState, evolveDimension, [
    {
      type: "catalog.dimension.created",
      data: { dimensionId: dimId, key: "color", name: l10n("Color"), description: l10n("") },
    },
  ] as DimensionEvent[]);
}

function orBetterState() {
  return givenEvents(initialDimensionState, evolveDimension, [
    {
      type: "catalog.dimension.created",
      data: {
        dimensionId: dimId,
        key: "condition",
        name: l10n("Condition"),
        description: l10n(""),
        valueKind: "ordered",
        optionMatching: "or-better",
      },
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
            optionMatching: "exact",
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

      expect(events[0].data).toMatchObject({ valueKind: "ordered", optionMatching: "exact" });
    });

    it.each(["ordered", "numeric"] as const)("creates an or-better %s dimension", (valueKind) => {
      const events = decide(decideDimension, initialDimensionState, {
        type: "CreateDimension" as const,
        dimensionId: dimId,
        key: "condition",
        name: l10n("Condition"),
        valueKind,
        optionMatching: "or-better",
      });

      expect(events[0].data).toMatchObject({ valueKind, optionMatching: "or-better" });
    });

    it("rejects an or-better unordered dimension", () => {
      expectDomainError(
        () =>
          decide(decideDimension, initialDimensionState, {
            type: "CreateDimension" as const,
            dimensionId: dimId,
            key: "color",
            name: l10n("Color"),
            optionMatching: "or-better",
          }),
        "Or-better option matching requires an ordered or numeric dimension.",
      );
    });

    it("rejects an unknown option matching", () => {
      expectDomainError(
        () =>
          decide(decideDimension, initialDimensionState, {
            type: "CreateDimension" as const,
            dimensionId: dimId,
            key: "condition",
            name: l10n("Condition"),
            valueKind: "ordered",
            optionMatching: "at-least" as "exact",
          }),
        "Dimension option matching must be exact or or-better.",
      );
    });

    it("keeps or-better option matching when a revision does not name it", () => {
      const events = decide(decideDimension, orBetterState(), {
        type: "ReviseDimension" as const,
        key: "condition",
        name: l10n("Card Condition"),
      });

      expect(events[0].data).toMatchObject({ valueKind: "ordered", optionMatching: "or-better" });
    });

    it("rejects revising an or-better dimension to unordered without also making it exact", () => {
      expectDomainError(
        () =>
          decide(decideDimension, orBetterState(), {
            type: "ReviseDimension" as const,
            key: "condition",
            name: l10n("Condition"),
            valueKind: "unordered",
          }),
        "Or-better option matching requires an ordered or numeric dimension.",
      );
    });

    it("revises an or-better dimension to unordered and exact together", () => {
      const events = decide(decideDimension, orBetterState(), {
        type: "ReviseDimension" as const,
        key: "condition",
        name: l10n("Condition"),
        valueKind: "unordered",
        optionMatching: "exact",
      });

      expect(events[0].data).toMatchObject({ valueKind: "unordered", optionMatching: "exact" });
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

    it.each([
      ["missing an option", [optionA]],
      ["including an extra option", [optionA, optionB, optionC]],
      ["duplicating an option", [optionA, optionA]],
    ])("rejects reordering when the option set is %s", (_reason, optionIds) => {
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
        () => decide(decideDimension, state, { type: "ReorderOptions" as const, optionIds }),
        reorderError,
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

    it("folds events recorded before option matching existed to exact", () => {
      const state = givenEvents(createdState(), evolveDimension, [
        {
          type: "catalog.dimension.revised",
          data: { key: "condition", name: l10n("Condition"), description: l10n(""), valueKind: "ordered" },
        },
      ] as DimensionEvent[]);

      expect(state.optionMatching).toBe("exact");
    });

    it("evolves option matching from created and revised events", () => {
      expect(orBetterState().optionMatching).toBe("or-better");

      const revised = evolveDimension(orBetterState(), {
        type: "catalog.dimension.revised",
        data: {
          key: "condition",
          name: l10n("Condition"),
          description: l10n(""),
          valueKind: "ordered",
          optionMatching: "exact",
        },
      } as DimensionEvent);

      expect(revised.optionMatching).toBe("exact");
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
