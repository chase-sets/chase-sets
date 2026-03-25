import { describe, it, expect } from "vitest";
import {
  decideField,
  evolveField,
  initialFieldState,
  type FieldEvent,
} from "./domain";
import type { FieldId } from "../../ids";
import { givenEvents, decide, expectDomainError } from "../test-helpers";

const fieldId = "fld_test" as FieldId;
const defaultBehavior = { filterable: false, searchable: false, sortable: false };

function createdState() {
  return givenEvents(initialFieldState, evolveField, [
    { type: "catalog.field.created", data: { fieldId, key: "brand", name: "Brand", description: "", valueType: "string", behavior: defaultBehavior } },
  ] as FieldEvent[]);
}

function activeState() {
  return givenEvents(initialFieldState, evolveField, [
    { type: "catalog.field.created", data: { fieldId, key: "brand", name: "Brand", description: "", valueType: "string", behavior: defaultBehavior } },
    { type: "catalog.field.activated", data: {} },
  ] as FieldEvent[]);
}

describe("Field aggregate", () => {
  describe("decideField", () => {
    it("creates a field", () => {
      const events = decide(decideField, initialFieldState, {
        type: "CreateField" as const,
        fieldId,
        key: "brand",
        name: "Brand",
        valueType: "string" as const,
        behavior: defaultBehavior,
      });

      expect(events[0].type).toBe("catalog.field.created");
    });

    it("rejects creating a field twice", () => {
      expectDomainError(
        () => decide(decideField, createdState(), {
          type: "CreateField" as const,
          fieldId: "fld_other" as FieldId,
          key: "x",
          name: "X",
          valueType: "string" as const,
          behavior: defaultBehavior,
        }),
        "Field has already been created.",
      );
    });

    it("configures a field", () => {
      const events = decide(decideField, createdState(), {
        type: "ConfigureField" as const,
        key: "brand-name",
        name: "Brand Name",
        valueType: "string" as const,
        behavior: { filterable: true, searchable: true, sortable: false },
      });

      expect(events[0].type).toBe("catalog.field.configured");
    });

    it("activates a draft field", () => {
      const events = decide(decideField, createdState(), { type: "ActivateField" as const });

      expect(events[0].type).toBe("catalog.field.activated");
    });

    it("rejects activating non-draft", () => {
      expectDomainError(
        () => decide(decideField, activeState(), { type: "ActivateField" as const }),
        "Only draft fields can be activated.",
      );
    });

    it("deprecates an active field", () => {
      const events = decide(decideField, activeState(), { type: "DeprecateField" as const });

      expect(events[0].type).toBe("catalog.field.deprecated");
    });

    it("archives a deprecated field", () => {
      const deprecatedState = givenEvents(activeState(), evolveField, [
        { type: "catalog.field.deprecated", data: {} },
      ] as FieldEvent[]);

      const events = decide(decideField, deprecatedState, { type: "ArchiveField" as const });

      expect(events[0].type).toBe("catalog.field.archived");
    });

    it("rejects configuring archived fields", () => {
      const archivedState = givenEvents(activeState(), evolveField, [
        { type: "catalog.field.deprecated", data: {} },
        { type: "catalog.field.archived", data: {} },
      ] as FieldEvent[]);

      expectDomainError(
        () => decide(decideField, archivedState, { type: "ConfigureField" as const, key: "x", name: "X", valueType: "string" as const, behavior: defaultBehavior }),
        "Archived fields cannot be reconfigured.",
      );
    });
  });

  describe("evolveField", () => {
    it("evolves created event", () => {
      const state = evolveField(initialFieldState, {
        type: "catalog.field.created",
        data: { fieldId, key: "brand", name: "Brand", description: "", valueType: "number", behavior: { filterable: true, searchable: false, sortable: true } },
      });

      expect(state.id).toBe(fieldId);
      expect(state.valueType).toBe("number");
      expect(state.behavior.filterable).toBe(true);
    });

    it("evolves configured event", () => {
      const state = evolveField(createdState(), {
        type: "catalog.field.configured",
        data: { key: "brand-v2", name: "Brand V2", description: "", valueType: "boolean", behavior: defaultBehavior },
      });

      expect(state.key).toBe("brand-v2");
      expect(state.valueType).toBe("boolean");
    });
  });
});
