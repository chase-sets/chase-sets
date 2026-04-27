import { describe, it, expect } from "vitest";
import {
  decideBlueprint,
  evolveBlueprint,
  initialBlueprintState,
  type BlueprintEvent,
} from "./domain";
import type { BlueprintId, ComponentId, DimensionId, FieldId, OptionId } from "../../../ids";
import { givenEvents, decide, expectDomainError } from "../../../support/authoring-support/test-helpers";

const bpId = "bpr_test" as BlueprintId;
const compA = "cmp_a" as ComponentId;
const dimA = "dim_a" as DimensionId;
const dimB = "dim_b" as DimensionId;
const fieldA = "fld_a" as FieldId;

function createdState() {
  return givenEvents(initialBlueprintState, evolveBlueprint, [
    { type: "catalog.blueprint.created", data: { blueprintId: bpId, key: "card", name: "Card", description: "" } },
  ] as BlueprintEvent[]);
}

function withDimensions() {
  return givenEvents(initialBlueprintState, evolveBlueprint, [
    { type: "catalog.blueprint.created", data: { blueprintId: bpId, key: "card", name: "Card", description: "" } },
    { type: "catalog.blueprint.dimensions-set", data: { dimensionRules: [
      { dimensionId: dimA, required: true, allowedOptionIds: [], appliesWhen: [] },
      { dimensionId: dimB, required: true, allowedOptionIds: [], appliesWhen: [] },
    ] } },
    { type: "catalog.blueprint.product-resolution-rules-set", data: { canonicalDimensionOrder: [dimA, dimB] } },
  ] as BlueprintEvent[]);
}

function activeState() {
  return givenEvents(initialBlueprintState, evolveBlueprint, [
    { type: "catalog.blueprint.created", data: { blueprintId: bpId, key: "card", name: "Card", description: "" } },
    { type: "catalog.blueprint.dimensions-set", data: { dimensionRules: [
      { dimensionId: dimA, required: true, allowedOptionIds: [], appliesWhen: [] },
    ] } },
    { type: "catalog.blueprint.product-resolution-rules-set", data: { canonicalDimensionOrder: [dimA] } },
    { type: "catalog.blueprint.published", data: {} },
  ] as BlueprintEvent[]);
}

describe("Blueprint aggregate", () => {
  describe("decideBlueprint", () => {
    it("creates a blueprint", () => {
      const events = decide(decideBlueprint, initialBlueprintState, {
        type: "CreateBlueprint" as const,
        blueprintId: bpId,
        key: "card",
        name: "Card",
      });

      expect(events[0].type).toBe("catalog.blueprint.created");
    });

    it("attaches a component", () => {
      const events = decide(decideBlueprint, createdState(), {
        type: "AttachComponentToBlueprint" as const,
        componentId: compA,
      });

      expect(events[0].type).toBe("catalog.blueprint.component-attached");
    });

    it("sets field rules", () => {
      const events = decide(decideBlueprint, createdState(), {
        type: "SetBlueprintFields" as const,
        fieldRules: [{ fieldId: fieldA, required: true }],
      });

      expect(events[0].type).toBe("catalog.blueprint.fields-set");
    });

    it("sets dimension rules", () => {
      const events = decide(decideBlueprint, createdState(), {
        type: "SetBlueprintDimensions" as const,
        dimensionRules: [{ dimensionId: dimA, required: true, allowedOptionIds: [] as OptionId[], appliesWhen: [] }],
      });

      expect(events[0].type).toBe("catalog.blueprint.dimensions-set");
    });

    it("normalizes conditional applicability on dimension rules", () => {
      const events = decide(decideBlueprint, createdState(), {
        type: "SetBlueprintDimensions" as const,
        dimensionRules: [{
          dimensionId: dimA,
          required: true,
          allowedOptionIds: [] as OptionId[],
          appliesWhen: [{ dimensionId: dimB, optionIds: ["chc_b" as OptionId, "chc_a" as OptionId, "chc_b" as OptionId] }],
        }],
      });

      expect(events[0]).toMatchObject({
        type: "catalog.blueprint.dimensions-set",
        data: {
          dimensionRules: [{
            dimensionId: dimA,
            appliesWhen: [{ dimensionId: dimB, optionIds: ["chc_a", "chc_b"] }],
          }],
        },
      });
    });

    it("rejects self-referential applicability on dimension rules", () => {
      expectDomainError(
        () => decide(decideBlueprint, createdState(), {
          type: "SetBlueprintDimensions" as const,
          dimensionRules: [{
            dimensionId: dimA,
            required: true,
            allowedOptionIds: [] as OptionId[],
            appliesWhen: [{ dimensionId: dimA, optionIds: ["chc_a" as OptionId] }],
          }],
        }),
        "Dimension rules cannot depend on their own dimension.",
      );
    });

    it("sets product resolution rules", () => {
      const state = givenEvents(createdState(), evolveBlueprint, [
        { type: "catalog.blueprint.dimensions-set", data: { dimensionRules: [{ dimensionId: dimA, required: true, allowedOptionIds: [], appliesWhen: [] }] } },
      ] as BlueprintEvent[]);

      const events = decide(decideBlueprint, state, {
        type: "SetBlueprintProductResolutionRules" as const,
        canonicalDimensionOrder: [dimA],
      });

      expect(events[0].type).toBe("catalog.blueprint.product-resolution-rules-set");
    });

    it("rejects product resolution rules that do not match dimensions", () => {
      expectDomainError(
        () => decide(decideBlueprint, createdState(), { type: "SetBlueprintProductResolutionRules" as const, canonicalDimensionOrder: [dimA] }),
        "Blueprint product resolution rules must include exactly the current dimensions.",
      );
    });

    it("publishes a blueprint with matching product resolution rules", () => {
      const state = withDimensions();
      const events = decide(decideBlueprint, state, { type: "PublishBlueprint" as const });

      expect(events[0].type).toBe("catalog.blueprint.published");
    });

    it("rejects publishing without canonical order for every dimension", () => {
      const state = givenEvents(createdState(), evolveBlueprint, [
        { type: "catalog.blueprint.dimensions-set", data: { dimensionRules: [{ dimensionId: dimA, required: true, allowedOptionIds: [], appliesWhen: [] }] } },
      ] as BlueprintEvent[]);

      expectDomainError(
        () => decide(decideBlueprint, state, { type: "PublishBlueprint" as const }),
        "Published blueprints require a canonical order for every dimension.",
      );
    });

    it("rejects structural changes to active blueprints", () => {
      expectDomainError(
        () => decide(decideBlueprint, activeState(), { type: "SetBlueprintFields" as const, fieldRules: [] }),
        "Only draft blueprints can change identity-bearing structure.",
      );
    });

    it("lifecycle: active -> deprecated -> archived", () => {
      const events = decide(decideBlueprint, activeState(), { type: "DeprecateBlueprint" as const });

      expect(events[0].type).toBe("catalog.blueprint.deprecated");

      const deprecatedState = givenEvents(activeState(), evolveBlueprint, [
        { type: "catalog.blueprint.deprecated", data: {} },
      ] as BlueprintEvent[]);

      const archiveEvents = decide(decideBlueprint, deprecatedState, { type: "ArchiveBlueprint" as const });

      expect(archiveEvents[0].type).toBe("catalog.blueprint.archived");
    });
  });

  describe("evolveBlueprint", () => {
    it("evolves created event", () => {
      const state = evolveBlueprint(initialBlueprintState, {
        type: "catalog.blueprint.created",
        data: { blueprintId: bpId, key: "card", name: "Card", description: "" },
      });

      expect(state.id).toBe(bpId);
      expect(state.status).toBe("draft");
    });

    it("evolves dimensions-set and prunes orphaned canonical order", () => {
      const state = givenEvents(initialBlueprintState, evolveBlueprint, [
        { type: "catalog.blueprint.created", data: { blueprintId: bpId, key: "card", name: "Card", description: "" } },
        { type: "catalog.blueprint.dimensions-set", data: { dimensionRules: [{ dimensionId: dimA, required: true, allowedOptionIds: [] }, { dimensionId: dimB, required: true, allowedOptionIds: [] }] } },
        { type: "catalog.blueprint.product-resolution-rules-set", data: { canonicalDimensionOrder: [dimA, dimB] } },
        { type: "catalog.blueprint.dimensions-set", data: { dimensionRules: [{ dimensionId: dimA, required: true, allowedOptionIds: [], appliesWhen: [] }] } },
      ] as BlueprintEvent[]);

      expect(state.canonicalDimensionOrder).toEqual([dimA]);
    });
  });
});

