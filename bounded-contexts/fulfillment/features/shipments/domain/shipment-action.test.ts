import { describe, expect, it } from "vitest";
import { FulfillmentDomainError, type ShipmentStatus } from "./common";
import {
  assertShipmentActionAllowed,
  executeShipmentAction,
  isShipmentActionAllowed,
  isTerminalShipmentStatus,
  resolveShipmentActionPlan,
  SHIPMENT_ACTION_NAMES,
  SHIPMENT_ACTION_RULES,
  type ShipmentActionName,
  type ShipmentLifecycleDispatcher,
} from "./shipment-action";

const ALL_STATUSES: readonly ShipmentStatus[] = [
  "awaiting-package",
  "packing",
  "awaiting-label",
  "label-attached",
  "cancelled",
  "dispatched",
  "delivered",
  "returned",
  "exception",
];

describe("shipment action legality", () => {
  it("permits an action exactly from the statuses named in its rule", () => {
    for (const action of SHIPMENT_ACTION_NAMES) {
      const rule = SHIPMENT_ACTION_RULES[action];
      for (const status of ALL_STATUSES) {
        const expected = rule.allowedFrom.includes(status);
        const labelStatus = rule.requiresLabelStatus ?? null;
        expect(isShipmentActionAllowed(action, { status, labelStatus })).toBe(expected);
      }
    }
  });

  it("rejects buying a label unless the shipment is awaiting one", () => {
    expect(isShipmentActionAllowed("buy-label", { status: "awaiting-label" })).toBe(true);
    expect(isShipmentActionAllowed("buy-label", { status: "packing" })).toBe(false);
    expect(isShipmentActionAllowed("buy-label", { status: "label-attached" })).toBe(false);
  });

  it("only voids a purchased label on a labeled shipment", () => {
    expect(isShipmentActionAllowed("void-label", { status: "label-attached", labelStatus: "purchased" })).toBe(true);
    expect(isShipmentActionAllowed("void-label", { status: "label-attached", labelStatus: "voided" })).toBe(false);
    expect(isShipmentActionAllowed("void-label", { status: "dispatched", labelStatus: "purchased" })).toBe(false);
  });

  it("never allows a lifecycle action from a terminal status", () => {
    for (const status of ["delivered", "returned", "cancelled"] as const) {
      expect(isTerminalShipmentStatus(status)).toBe(true);
      for (const action of SHIPMENT_ACTION_NAMES) {
        expect(isShipmentActionAllowed(action, { status, labelStatus: "purchased" })).toBe(false);
      }
    }
  });

  it("asserts with a status-specific message on an illegal transition", () => {
    expect(() => assertShipmentActionAllowed("dispatch", { status: "awaiting-package" })).toThrow(
      FulfillmentDomainError,
    );
    expect(() => assertShipmentActionAllowed("dispatch", { status: "awaiting-package" })).toThrow(/awaiting-package/);
    expect(() =>
      assertShipmentActionAllowed("void-label", { status: "label-attached", labelStatus: "voided" }),
    ).toThrow(/label/);
  });
});

describe("context-aware action plan", () => {
  const cases: ReadonlyArray<Readonly<{ status: ShipmentStatus; primary: ShipmentActionName | null }>> = [
    { status: "awaiting-package", primary: "start-packing" },
    { status: "packing", primary: "complete-packing" },
    { status: "awaiting-label", primary: "buy-label" },
    { status: "label-attached", primary: "dispatch" },
    { status: "dispatched", primary: null },
    { status: "exception", primary: null },
    { status: "delivered", primary: null },
    { status: "returned", primary: null },
    { status: "cancelled", primary: null },
  ];

  it("surfaces the one next action for each live status", () => {
    for (const { status, primary } of cases) {
      expect(resolveShipmentActionPlan({ status }).primary).toBe(primary);
    }
  });

  it("discloses void and exception on a labeled shipment but keeps dispatch primary", () => {
    const plan = resolveShipmentActionPlan({ status: "label-attached", labelStatus: "purchased" });
    expect(plan.primary).toBe("dispatch");
    expect(plan.disclosed).toContain("void-label");
    expect(plan.disclosed).toContain("raise-exception");
    expect(plan.disclosed).not.toContain("dispatch");
  });

  it("offers deliver, return, and exception on a dispatched shipment", () => {
    const plan = resolveShipmentActionPlan({ status: "dispatched" });
    expect(plan.primary).toBeNull();
    expect(plan.disclosed).toEqual(["record-delivery", "return", "raise-exception"]);
  });

  it("marks terminal shipments with no actions", () => {
    const plan = resolveShipmentActionPlan({ status: "delivered" });
    expect(plan.terminal).toBe(true);
    expect(plan.primary).toBeNull();
    expect(plan.disclosed).toEqual([]);
  });
});

describe("transport-agnostic executor", () => {
  function fakeDispatcher(): { dispatcher: ShipmentLifecycleDispatcher; calls: Record<string, number> } {
    const calls: Record<string, number> = {};
    const result = { shipmentId: "shp_1", version: 3 };
    const track = (key: string) => async () => {
      calls[key] = (calls[key] ?? 0) + 1;
      return result;
    };
    return {
      calls,
      dispatcher: {
        startPacking: track("startPacking"),
        completePacking: track("completePacking"),
        dispatch: track("dispatch"),
        recordDelivery: track("recordDelivery"),
        returnShipment: track("returnShipment"),
        raiseException: track("raiseException"),
      },
    };
  }

  it("dispatches the matching lifecycle command when the action is legal", async () => {
    const { dispatcher, calls } = fakeDispatcher();
    const result = await executeShipmentAction(dispatcher, {
      action: "dispatch",
      current: { status: "label-attached" },
    });
    expect(result).toEqual({ shipmentId: "shp_1", version: 3 });
    expect(calls.dispatch).toBe(1);
  });

  it("rejects an illegal transition before touching the dispatcher", async () => {
    const { dispatcher, calls } = fakeDispatcher();
    await expect(
      executeShipmentAction(dispatcher, { action: "dispatch", current: { status: "awaiting-package" } }),
    ).rejects.toBeInstanceOf(FulfillmentDomainError);
    expect(calls.dispatch).toBeUndefined();
  });

  it("routes label actions to the dedicated postage path instead of the lifecycle executor", async () => {
    const { dispatcher } = fakeDispatcher();
    await expect(
      executeShipmentAction(dispatcher, { action: "buy-label", current: { status: "awaiting-label" } }),
    ).rejects.toThrow(/postage-label path/);
  });

  it("invokes the raise-exception command from a live in-transit shipment", async () => {
    const { dispatcher, calls } = fakeDispatcher();
    await executeShipmentAction(dispatcher, { action: "raise-exception", current: { status: "dispatched" } });
    expect(calls.raiseException).toBe(1);
  });
});
