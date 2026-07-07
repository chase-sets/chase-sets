import { describe, expect, it } from "vitest";
import {
  decideRestockDecision,
  evolveRestockDecision,
  initialRestockDecisionState,
  type RestockDecisionEvent,
} from "./domain";

const pendingCommand = {
  type: "MarkRestockDecisionPending",
  decisionId: "rstk_1",
  accountId: "acc_seller",
  orderId: "ord_1",
  itemId: "inv_1",
  quantity: 1,
  source: "shipment-returned",
  sourceRef: {
    orderId: "ord_1",
    reservationRequestId: "rsv_1",
  },
  shipmentId: "shp_1",
  returnReason: "condition-dispute",
  pendingAt: "2026-07-07T01:00:00.000Z",
} as const;

describe("restock decision domain", () => {
  it("marks a returned item pending once for the same order item", () => {
    const events = decideRestockDecision(initialRestockDecisionState, pendingCommand);
    const state = events.reduce(evolveRestockDecision, initialRestockDecisionState);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "inventory.restock-decision.pending",
      data: {
        decisionId: "rstk_1",
        accountId: "acc_seller",
        orderId: "ord_1",
        itemId: "inv_1",
        quantity: 1,
      },
    });
    expect(decideRestockDecision(state, pendingCommand)).toEqual([]);
  });

  it("records restocked and written-off outcomes with seller-facing reasons", () => {
    const pending = decideRestockDecision(initialRestockDecisionState, pendingCommand);
    const state = pending.reduce(evolveRestockDecision, initialRestockDecisionState);

    expect(
      decideRestockDecision(state, {
        type: "RecordRestockDecision",
        outcome: "restocked",
        decidedAt: "2026-07-07T01:05:00.000Z",
      }),
    ).toEqual([
      {
        type: "inventory.restock-decision.recorded",
        data: expect.objectContaining({
          outcome: "restocked",
          reason: "return-restocked",
          sourceRef: {
            orderId: "ord_1",
            reservationRequestId: "rsv_1",
          },
        }),
      },
    ] satisfies RestockDecisionEvent[]);

    expect(
      decideRestockDecision(state, {
        type: "RecordRestockDecision",
        outcome: "written-off",
        damageNote: "Corner crease",
        decidedAt: "2026-07-07T01:05:00.000Z",
      }),
    ).toEqual([
      {
        type: "inventory.restock-decision.recorded",
        data: expect.objectContaining({
          outcome: "written-off",
          reason: "written-off",
          damageNote: "Corner crease",
        }),
      },
    ] satisfies RestockDecisionEvent[]);
  });
});
