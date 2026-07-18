import { describe, expect, it } from "vitest";
import { decideInventoryHoldCollision, initialInventoryHoldCollisionState, planInventoryHoldCollision } from "./domain";

const orderHold = (holdId: string, quantity: number, orderId: string, committedAt: string) => ({
  holdId,
  quantity,
  purpose: "order",
  sourceRef: { orderId, reservationRequestId: `rsv_${orderId}` },
  committedAt,
});

describe("inventory hold collision", () => {
  it("does not plan a collision when the reduction fits available quantity", () => {
    expect(
      planInventoryHoldCollision({
        totalQuantity: 10,
        requestedQuantity: 4,
        mode: "protect-orders",
        actorRole: null,
        activeHolds: [orderHold("hld_1", 6, "ord_1", "2026-07-01T00:00:00.000Z")],
      }),
    ).toBeNull();
  });

  it("protects orders by applying only available stock and refusing the remainder", () => {
    const plan = planInventoryHoldCollision({
      totalQuantity: 10,
      requestedQuantity: 6,
      mode: "protect-orders",
      actorRole: null,
      activeHolds: [orderHold("hld_1", 6, "ord_1", "2026-07-01T00:00:00.000Z")],
    });

    expect(plan).toMatchObject({
      appliedQuantity: 4,
      refusedQuantity: 2,
      releasedHoldQuantity: 0,
      affectedOrders: [{ orderId: "ord_1", disposition: "protected" }],
    });
  });

  it("honors offline stock by displacing newest whole order commitments first", () => {
    const plan = planInventoryHoldCollision({
      totalQuantity: 10,
      requestedQuantity: 6,
      mode: "honor-offline",
      actorRole: "manager",
      activeHolds: [
        orderHold("hld_old", 3, "ord_old", "2026-07-01T00:00:00.000Z"),
        orderHold("hld_new", 3, "ord_new", "2026-07-02T00:00:00.000Z"),
      ],
    });

    expect(plan).toMatchObject({
      authorizedByRole: "manager",
      appliedQuantity: 6,
      refusedQuantity: 0,
      releasedHoldQuantity: 3,
      affectedOrders: [{ holdId: "hld_new", orderId: "ord_new", disposition: "released" }],
    });
  });

  it("requires manager authorization and never displaces non-order holds", () => {
    const input = {
      totalQuantity: 5,
      requestedQuantity: 4,
      mode: "honor-offline" as const,
      activeHolds: [
        {
          holdId: "hld_manual",
          quantity: 3,
          purpose: "manual",
          sourceRef: null,
          committedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    };

    expect(() => planInventoryHoldCollision({ ...input, actorRole: "fulfillment" })).toThrow(
      "manager or owner authorization",
    );
    expect(() => planInventoryHoldCollision({ ...input, actorRole: "owner" })).toThrow(
      "cannot displace manual or checkout",
    );
  });

  it("rejects unauthorized Honor Offline plans in the domain decider", () => {
    const command = {
      type: "RecordInventoryHoldCollision" as const,
      collisionId: "ihc_1",
      accountId: "acc_1",
      itemId: "inv_1",
      storageLocationId: "loc_1",
      reason: "Counter sale",
      recordedAt: "2026-07-17T12:00:00.000Z",
      totalQuantityBefore: 5,
      plan: {
        mode: "honor-offline" as const,
        authorizedByRole: null,
        requestedQuantity: 4,
        appliedQuantity: 4,
        refusedQuantity: 0,
        heldQuantity: 3,
        availableQuantity: 2,
        releasedHoldQuantity: 3,
        affectedOrders: [],
      },
    };

    expect(() => decideInventoryHoldCollision(initialInventoryHoldCollisionState, command)).toThrow(
      "manager or owner authorization",
    );
    expect(
      decideInventoryHoldCollision(initialInventoryHoldCollisionState, {
        ...command,
        plan: { ...command.plan, authorizedByRole: "manager" },
      }),
    ).toEqual([
      expect.objectContaining({
        type: "inventory.hold-collision-recorded",
        data: expect.objectContaining({ authorizedByRole: "manager", mode: "honor-offline" }),
      }),
    ]);
  });

  it("records the collision quantities and affected order evidence as an event", () => {
    const plan = planInventoryHoldCollision({
      totalQuantity: 5,
      requestedQuantity: 4,
      mode: "protect-orders",
      actorRole: null,
      activeHolds: [orderHold("hld_1", 3, "ord_1", "2026-07-01T00:00:00.000Z")],
    })!;

    const events = decideInventoryHoldCollision(initialInventoryHoldCollisionState, {
      type: "RecordInventoryHoldCollision",
      collisionId: "ihc_1",
      accountId: "acc_1",
      itemId: "inv_1",
      storageLocationId: "loc_1",
      reason: "Counter sale",
      recordedAt: "2026-07-17T12:00:00.000Z",
      totalQuantityBefore: 5,
      plan,
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "inventory.hold-collision-recorded",
        data: expect.objectContaining({
          collisionId: "ihc_1",
          mode: "protect-orders",
          requestedQuantity: 4,
          appliedQuantity: 2,
          refusedQuantity: 2,
          totalQuantityAfter: 3,
        }),
      }),
    ]);
  });
});
