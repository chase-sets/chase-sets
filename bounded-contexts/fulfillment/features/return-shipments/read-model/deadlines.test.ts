import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETURN_SHIPMENT_DEADLINE_POLICY,
  customerSafeReturnShipmentDeadlineSignals,
  deriveReturnShipmentDeadlineSignals,
  type ReturnShipmentDeadlineInput,
} from "./deadlines";

const baseline: ReturnShipmentDeadlineInput = {
  status: "ready-to-ship",
  shipByDeadlineAt: "2026-06-10T00:00:00.000Z",
  labelStatus: "ready",
  lastMovementAt: null,
  deliveredAt: null,
  receivedAt: null,
};

function codes(input: ReturnShipmentDeadlineInput, asOf: string) {
  return deriveReturnShipmentDeadlineSignals(input, asOf).map((signal) => signal.code);
}

describe("deriveReturnShipmentDeadlineSignals", () => {
  it("is silent well before any deadline", () => {
    expect(codes(baseline, "2026-06-01T00:00:00.000Z")).toEqual([]);
  });

  it("emits a customer-safe ship-by reminder inside the reminder window", () => {
    // reminder lead is 48h; deadline 06-10 → reminder from 06-08.
    expect(codes(baseline, "2026-06-09T00:00:00.000Z")).toContain("ship-by-reminder");
  });

  it("flags ship-by overdue once the deadline passes and escalates after the escalation window", () => {
    const overdue = deriveReturnShipmentDeadlineSignals(baseline, "2026-06-10T01:00:00.000Z");
    const signal = overdue.find((entry) => entry.code === "ship-by-overdue");
    expect(signal).toMatchObject({ exceptionType: "abandoned", escalated: false });

    const escalated = deriveReturnShipmentDeadlineSignals(baseline, "2026-06-14T00:00:00.000Z").find(
      (entry) => entry.code === "ship-by-overdue",
    );
    expect(escalated?.escalated).toBe(true);
  });

  it("marks an unshipped label void-eligible after the grace window", () => {
    // ship-by 06-10 + 72h grace → void-eligible from 06-13.
    expect(codes(baseline, "2026-06-13T01:00:00.000Z")).toContain("label-void-eligible");
    const signal = deriveReturnShipmentDeadlineSignals(baseline, "2026-06-13T01:00:00.000Z").find(
      (entry) => entry.code === "label-void-eligible",
    );
    expect(signal?.customerSafeStatus).toBeNull();
  });

  it("flags a stalled-in-transit shipment with no recent movement", () => {
    const input: ReturnShipmentDeadlineInput = {
      ...baseline,
      status: "in-transit",
      lastMovementAt: "2026-06-11T00:00:00.000Z",
    };
    // stalled threshold 120h → stalled from 06-16.
    expect(codes(input, "2026-06-12T00:00:00.000Z")).not.toContain("stalled-in-transit");
    const stalled = deriveReturnShipmentDeadlineSignals(input, "2026-06-17T00:00:00.000Z").find(
      (entry) => entry.code === "stalled-in-transit",
    );
    expect(stalled).toMatchObject({ exceptionType: "carrier-delay" });
  });

  it("flags a delivered-but-not-intaken shipment past the intake threshold", () => {
    const input: ReturnShipmentDeadlineInput = {
      ...baseline,
      status: "delivered",
      deliveredAt: "2026-06-15T00:00:00.000Z",
      receivedAt: null,
    };
    // intake threshold 48h → gap from 06-17.
    expect(codes(input, "2026-06-16T00:00:00.000Z")).not.toContain("delivery-without-intake");
    expect(codes(input, "2026-06-18T00:00:00.000Z")).toContain("delivery-without-intake");
  });

  it("surfaces no live deadline once the shipment is received", () => {
    const input: ReturnShipmentDeadlineInput = {
      ...baseline,
      status: "received",
      deliveredAt: "2026-06-15T00:00:00.000Z",
      receivedAt: "2026-06-15T02:00:00.000Z",
    };
    expect(codes(input, "2026-06-30T00:00:00.000Z")).toEqual([]);
  });

  it("projects only customer-safe signals for the buyer", () => {
    const signals = deriveReturnShipmentDeadlineSignals(baseline, "2026-06-13T01:00:00.000Z");
    const customer = customerSafeReturnShipmentDeadlineSignals(signals);
    // label-void-eligible is operator-internal and must not reach the buyer.
    expect(customer.some((entry) => entry.code === "label-void-eligible")).toBe(false);
  });

  it("uses the documented default thresholds", () => {
    expect(DEFAULT_RETURN_SHIPMENT_DEADLINE_POLICY.shipByReminderLeadHours).toBe(48);
  });
});
