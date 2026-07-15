import { describe, expect, it } from "vitest";
import {
  decideUnidentifiedReturnPackage,
  evolveUnidentifiedReturnPackage,
  initialUnidentifiedReturnPackageState,
} from "./unidentified-package";

const evidence = {
  attachmentId: "rie_1",
  storageKey: "return-intake/fac_east/rie_1/a.jpg",
  contentType: "image/jpeg" as const,
  byteSize: 10,
  sha256: "a".repeat(64),
  uploadedAt: "2026-07-14T11:59:00.000Z",
  retentionUntil: "2027-07-14T11:59:00.000Z",
  securityScanStatus: "clean" as const,
};

function recordedState() {
  const events = decideUnidentifiedReturnPackage(initialUnidentifiedReturnPackageState, {
    type: "RecordUnidentifiedReturnPackage",
    unidentifiedPackageId: "urp_1" as never,
    facilityId: "fac_east",
    stationId: "station-1",
    operatorUserId: "usr_operator",
    receivedAt: "2026-07-14T12:00:00.000Z",
    packageCondition: "unreadable",
    sealCondition: "broken",
    measuredWeightOunces: 8,
    evidence: [evidence],
    custodyIdentifier: "CUST-U-1",
    notes: "Label damaged",
    owner: "Fulfillment",
    nextAction: "Identify from carrier manifest",
  });
  return events.reduce(evolveUnidentifiedReturnPackage, initialUnidentifiedReturnPackageState);
}

describe("UnidentifiedReturnPackage", () => {
  it("requires evidence and preserves receipt history through reconciliation", () => {
    const recorded = recordedState();
    const events = decideUnidentifiedReturnPackage(recorded, {
      type: "ReconcileUnidentifiedReturnPackage",
      returnShipmentId: "rsh_1" as never,
      reconciledByUserId: "usr_supervisor",
      reconciledAt: "2026-07-15T12:00:00.000Z",
      reason: "Carrier supplied a corrected tracking manifest",
    });
    const reconciled = events.reduce(evolveUnidentifiedReturnPackage, recorded);
    expect(reconciled.returnShipmentId).toBe("rsh_1");
    expect(reconciled.evidence).toEqual(recorded.evidence);
    expect(reconciled.receivedAt).toBe(recorded.receivedAt);
  });

  it("cannot be reconciled to a second Return Shipment", () => {
    const recorded = recordedState();
    const reconciled = decideUnidentifiedReturnPackage(recorded, {
      type: "ReconcileUnidentifiedReturnPackage",
      returnShipmentId: "rsh_1" as never,
      reconciledByUserId: "usr_supervisor",
      reconciledAt: "2026-07-15T12:00:00.000Z",
      reason: "Manifest match",
    }).reduce(evolveUnidentifiedReturnPackage, recorded);
    expect(() =>
      decideUnidentifiedReturnPackage(reconciled, {
        type: "ReconcileUnidentifiedReturnPackage",
        returnShipmentId: "rsh_2" as never,
        reconciledByUserId: "usr_supervisor",
        reconciledAt: "2026-07-15T13:00:00.000Z",
        reason: "Changed mind",
      }),
    ).toThrow("another return shipment");
  });
});
