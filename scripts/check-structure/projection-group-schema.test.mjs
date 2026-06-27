import { describe, expect, it } from "vitest";
import { validateEventReactionDeclaration, validateProjectionGroupOwnershipReset } from "./run.mjs";

function validate(projectionGroup) {
  return validateProjectionGroupOwnershipReset(
    projectionGroup,
    "bounded-contexts/inventory/context.json projectionGroups[0]",
  );
}

describe("projection group ownership/reset schema", () => {
  it("accepts side-effect-only workflow groups without owned tables", () => {
    expect(
      validate({
        projectionName: "inventory-order-reservation-workflow",
        sourceContextNames: ["ordering"],
        ownedTables: [],
        resetStrategy: "replay-only",
        sideEffectOnly: true,
        requiredDuringBootstrap: false,
      }),
    ).toEqual([]);
  });

  it("requires ordinary projection groups to own at least one table", () => {
    expect(
      validate({
        projectionName: "inventory-reservation-projection",
        sourceContextNames: ["inventory"],
        ownedTables: [],
        resetStrategy: "truncate-owned-tables",
      }),
    ).toEqual([
      "bounded-contexts/inventory/context.json projectionGroups[0]: ownedTables must be a non-empty array of strings unless sideEffectOnly is true",
    ]);
  });

  it("rejects side-effect-only groups that own tables or reset destructively", () => {
    expect(
      validate({
        projectionName: "inventory-order-reservation-workflow",
        sourceContextNames: ["ordering"],
        ownedTables: ["inventory_reservation_pages"],
        resetStrategy: "truncate-owned-tables",
        sideEffectOnly: true,
      }),
    ).toEqual([
      "bounded-contexts/inventory/context.json projectionGroups[0]: sideEffectOnly projection groups must not declare ownedTables",
      "bounded-contexts/inventory/context.json projectionGroups[0]: sideEffectOnly projection groups must use replay-only resetStrategy",
    ]);
  });

  it("accepts reaction groups with explicit replay-only semantics and no read-model table", () => {
    expect(
      validate({
        projectionName: "ordering-inventory-reservation-outcomes",
        handlerKind: "reaction",
        sourceContextNames: ["inventory"],
        ownedTables: [],
        resetStrategy: "replay-only",
        requiredDuringBootstrap: false,
      }),
    ).toEqual([]);
  });

  it("rejects reaction groups with destructive reset semantics", () => {
    expect(
      validate({
        projectionName: "ordering-payment-capture",
        handlerKind: "reaction",
        sourceContextNames: ["payments"],
        ownedTables: ["ordering_payment_capture_inputs"],
        resetStrategy: "truncate-owned-tables",
        requiredDuringBootstrap: false,
      }),
    ).toEqual([
      "bounded-contexts/inventory/context.json projectionGroups[0]: reaction groups must use replay-only resetStrategy",
    ]);
  });
});

describe("event reaction schema", () => {
  it("accepts reactions with explicit idempotency, retry, and failure policies", () => {
    expect(
      validateEventReactionDeclaration(
        {
          sourceContextName: "inventory",
          reactionName: "ordering-inventory-reservation-outcomes",
          subscriptionVersion: 1,
          reactionHandlerSetNames: ["ordering-inventory-reservation-outcomes"],
          idempotencyPolicy: "idempotent-command-dispatch",
          retryPolicy: "retry-from-last-checkpoint",
          failurePolicy: "surface-as-reaction-failure",
        },
        "bounded-contexts/ordering/context.json eventReactions[0]",
      ),
    ).toEqual([]);
  });

  it("rejects command-dispatch reactions declared without reaction semantics", () => {
    expect(
      validateEventReactionDeclaration(
        {
          sourceContextName: "inventory",
          reactionName: "ordering-inventory-reservation-outcomes",
          subscriptionVersion: 1,
          reactionHandlerSetNames: ["ordering-inventory-reservation-outcomes"],
        },
        "bounded-contexts/ordering/context.json eventReactions[0]",
      ),
    ).toEqual([
      "bounded-contexts/ordering/context.json eventReactions[0]: idempotencyPolicy must be idempotent-command-dispatch",
      "bounded-contexts/ordering/context.json eventReactions[0]: retryPolicy must be retry-from-last-checkpoint",
      "bounded-contexts/ordering/context.json eventReactions[0]: failurePolicy must be surface-as-reaction-failure",
    ]);
  });
});
