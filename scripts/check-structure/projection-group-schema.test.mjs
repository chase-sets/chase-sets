import { describe, expect, it } from "vitest";
import { validateProjectionGroupOwnershipReset } from "./run.mjs";

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
});
