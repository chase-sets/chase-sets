import { describe, it, expect } from "vitest";
import { decideComponent, evolveComponent, initialComponentState, type ComponentEvent } from "./domain";
import type { ComponentId, DimensionId, FieldId, OptionId } from "../../../ids";
import { givenEvents, decide, expectDomainError } from "../../../support/authoring-support/test-helpers";
import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";

const compId = "cmp_test" as ComponentId;
const fieldA = "fld_a" as FieldId;
const fieldB = "fld_b" as FieldId;
const dimA = "dim_a" as DimensionId;
const l10n = localizedTextMapFromEnglish;

function createdState() {
  return givenEvents(initialComponentState, evolveComponent, [
    {
      type: "catalog.component.created",
      data: { componentId: compId, key: "base", name: l10n("Base"), description: l10n("") },
    },
  ] as ComponentEvent[]);
}

function activeState() {
  return givenEvents(initialComponentState, evolveComponent, [
    {
      type: "catalog.component.created",
      data: { componentId: compId, key: "base", name: l10n("Base"), description: l10n("") },
    },
    { type: "catalog.component.activated", data: {} },
  ] as ComponentEvent[]);
}

describe("Component aggregate", () => {
  describe("decideComponent", () => {
    it("creates a component", () => {
      const events = decide(decideComponent, initialComponentState, {
        type: "CreateComponent" as const,
        componentId: compId,
        key: "base",
        name: l10n("Base"),
      });

      expect(events[0].type).toBe("catalog.component.created");
    });

    it("rejects creating twice", () => {
      expectDomainError(
        () =>
          decide(decideComponent, createdState(), {
            type: "CreateComponent" as const,
            componentId: compId,
            key: "x",
            name: l10n("X"),
          }),
        "Component has already been created.",
      );
    });

    it("adds a field rule", () => {
      const events = decide(decideComponent, createdState(), {
        type: "AddFieldRuleToComponent" as const,
        fieldId: fieldA,
        required: true,
      });

      expect(events[0].type).toBe("catalog.component.field-rule-added");
    });

    it("rejects duplicate field rules", () => {
      const state = givenEvents(createdState(), evolveComponent, [
        { type: "catalog.component.field-rule-added", data: { fieldId: fieldA, required: true } },
      ] as ComponentEvent[]);

      expectDomainError(
        () =>
          decide(decideComponent, state, {
            type: "AddFieldRuleToComponent" as const,
            fieldId: fieldA,
            required: false,
          }),
        "Component already contains that field rule.",
      );
    });

    it("removes a field rule", () => {
      const state = givenEvents(createdState(), evolveComponent, [
        { type: "catalog.component.field-rule-added", data: { fieldId: fieldA, required: true } },
      ] as ComponentEvent[]);

      const events = decide(decideComponent, state, { type: "RemoveFieldRuleFromComponent" as const, fieldId: fieldA });

      expect(events[0].type).toBe("catalog.component.field-rule-removed");
    });

    it("adds a dimension rule", () => {
      const events = decide(decideComponent, createdState(), {
        type: "AddDimensionRuleToComponent" as const,
        dimensionId: dimA,
        required: true,
      });

      expect(events[0].type).toBe("catalog.component.dimension-rule-added");
    });

    it("normalizes conditional applicability on dimension rules", () => {
      const events = decide(decideComponent, createdState(), {
        type: "AddDimensionRuleToComponent" as const,
        dimensionId: dimA,
        required: true,
        appliesWhen: [
          {
            dimensionId: "dim_b" as DimensionId,
            optionIds: ["chc_b" as OptionId, "chc_a" as OptionId, "chc_b" as OptionId],
          },
        ],
      });

      expect(events[0]).toMatchObject({
        type: "catalog.component.dimension-rule-added",
        data: {
          dimensionId: dimA,
          appliesWhen: [{ dimensionId: "dim_b", optionIds: ["chc_a", "chc_b"] }],
        },
      });
    });

    it("rejects self-referential applicability on dimension rules", () => {
      expectDomainError(
        () =>
          decide(decideComponent, createdState(), {
            type: "AddDimensionRuleToComponent" as const,
            dimensionId: dimA,
            required: true,
            appliesWhen: [{ dimensionId: dimA, optionIds: ["chc_a" as OptionId] }],
          }),
        "Dimension rules cannot depend on their own dimension.",
      );
    });

    it("configures component rules", () => {
      const events = decide(decideComponent, createdState(), {
        type: "ConfigureComponentRules" as const,
        key: "base-v2",
        name: l10n("Base V2"),
        fieldRules: [{ fieldId: fieldA, required: true }],
        dimensionRules: [{ dimensionId: dimA, required: true, allowedOptionIds: [] as OptionId[], appliesWhen: [] }],
      });

      expect(events[0].type).toBe("catalog.component.rules-configured");
    });

    it("lifecycle: draft -> active -> deprecated -> archived", () => {
      let events = decide(decideComponent, createdState(), { type: "ActivateComponent" as const });

      expect(events[0].type).toBe("catalog.component.activated");

      events = decide(decideComponent, activeState(), { type: "DeprecateComponent" as const });
      expect(events[0].type).toBe("catalog.component.deprecated");

      const deprecatedState = givenEvents(activeState(), evolveComponent, [
        { type: "catalog.component.deprecated", data: {} },
      ] as ComponentEvent[]);

      events = decide(decideComponent, deprecatedState, { type: "ArchiveComponent" as const });
      expect(events[0].type).toBe("catalog.component.archived");
    });

    it("rejects changes to archived components", () => {
      const archivedState = givenEvents(activeState(), evolveComponent, [
        { type: "catalog.component.deprecated", data: {} },
        { type: "catalog.component.archived", data: {} },
      ] as ComponentEvent[]);

      expectDomainError(
        () =>
          decide(decideComponent, archivedState, {
            type: "AddFieldRuleToComponent" as const,
            fieldId: fieldB,
            required: false,
          }),
        "Only draft components can change field or dimension rules.",
      );
    });

    it("rejects field rule changes on active components (structure locks after publish)", () => {
      expectDomainError(
        () =>
          decide(decideComponent, activeState(), {
            type: "AddFieldRuleToComponent" as const,
            fieldId: fieldA,
            required: true,
          }),
        "Only draft components can change field or dimension rules.",
      );

      const withRule = givenEvents(createdState(), evolveComponent, [
        { type: "catalog.component.field-rule-added", data: { fieldId: fieldA, required: true } },
        { type: "catalog.component.activated", data: {} },
      ] as ComponentEvent[]);

      expectDomainError(
        () => decide(decideComponent, withRule, { type: "RemoveFieldRuleFromComponent" as const, fieldId: fieldA }),
        "Only draft components can change field or dimension rules.",
      );
    });

    it("rejects dimension rule changes on active components (structure locks after publish)", () => {
      expectDomainError(
        () =>
          decide(decideComponent, activeState(), {
            type: "AddDimensionRuleToComponent" as const,
            dimensionId: dimA,
            required: true,
          }),
        "Only draft components can change field or dimension rules.",
      );
    });

    it("rejects rule changes on deprecated components", () => {
      const deprecatedState = givenEvents(activeState(), evolveComponent, [
        { type: "catalog.component.deprecated", data: {} },
      ] as ComponentEvent[]);

      expectDomainError(
        () =>
          decide(decideComponent, deprecatedState, {
            type: "AddDimensionRuleToComponent" as const,
            dimensionId: dimA,
            required: true,
          }),
        "Only draft components can change field or dimension rules.",
      );
    });
  });

  describe("evolveComponent", () => {
    it("evolves created event", () => {
      const state = evolveComponent(initialComponentState, {
        type: "catalog.component.created",
        data: { componentId: compId, key: "base", name: l10n("Base"), description: l10n("") },
      });

      expect(state.id).toBe(compId);
      expect(state.key).toBe("base");
    });

    it("evolves field rule added", () => {
      const state = evolveComponent(createdState(), {
        type: "catalog.component.field-rule-added",
        data: { fieldId: fieldA, required: true },
      });

      expect(state.fieldRules).toHaveLength(1);
      expect(state.fieldRules[0].fieldId).toBe(fieldA);
    });

    it("evolves field rule removed", () => {
      const withRule = givenEvents(createdState(), evolveComponent, [
        { type: "catalog.component.field-rule-added", data: { fieldId: fieldA, required: true } },
      ] as ComponentEvent[]);

      const state = evolveComponent(withRule, {
        type: "catalog.component.field-rule-removed",
        data: { fieldId: fieldA },
      });

      expect(state.fieldRules).toHaveLength(0);
    });
  });
});
