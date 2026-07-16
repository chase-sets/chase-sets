import { describe, expect, it } from "vitest";
import {
  createSellerReturnDestination,
  createReturnFacilityDirectory,
  customerSafeDestination,
  selectReturnFacility,
  type ReturnFacilityInput,
  type ReturnFacilitySelectionCriteria,
} from "./facility-directory";

function facility(overrides: Partial<ReturnFacilityInput> = {}): ReturnFacilityInput {
  return {
    facilityId: "fac_east",
    configVersion: "v1",
    effectiveAt: "2026-01-01T00:00:00.000Z",
    retiredAt: null,
    supportedReturnPrograms: ["platform-custody"],
    supportedCarriers: ["usps"],
    supportedRegions: ["us-east"],
    packageConstraints: { maxWeightOunces: 80, maxLengthInches: 24, maxWidthInches: 18, maxHeightInches: 12 },
    postalAddress: {
      name: "Chase Sets Returns East",
      line1: "100 Dock St",
      city: "Newark",
      state: "NJ",
      postalCode: "07102",
      country: "US",
    },
    restrictedRouting: { operationalContact: "ops-east@chasesets.internal", internalRoutingCode: "EAST-42" },
    displayName: "Chase Sets Returns (East)",
    displayInstructions: "Include the packing slip inside the box.",
    ...overrides,
  };
}

const criteria: ReturnFacilitySelectionCriteria = {
  returnProgram: "platform-custody",
  carrier: "usps",
  region: "us-east",
  packageWeightOunces: 10,
  packageLengthInches: 9,
  packageWidthInches: 6,
  packageHeightInches: 2,
};

const options = { asOf: "2026-06-01T00:00:00.000Z", selectionPolicyVersion: "facility-selection-v1" } as const;

describe("return facility directory", () => {
  it("rejects a facility whose retired date precedes its effective date", () => {
    expect(() =>
      createReturnFacilityDirectory([
        facility({ effectiveAt: "2026-02-01T00:00:00.000Z", retiredAt: "2026-01-01T00:00:00.000Z" }),
      ]),
    ).toThrow();
  });

  it("rejects duplicate facility ids", () => {
    expect(() => createReturnFacilityDirectory([facility(), facility({ configVersion: "v2" })])).toThrow();
  });

  it("selects deterministically by lowest facility id regardless of directory order", () => {
    const forward = createReturnFacilityDirectory([
      facility({ facilityId: "fac_b" }),
      facility({ facilityId: "fac_a" }),
    ]);
    const reversed = createReturnFacilityDirectory([
      facility({ facilityId: "fac_a" }),
      facility({ facilityId: "fac_b" }),
    ]);
    const a = selectReturnFacility(forward, criteria, options);
    const b = selectReturnFacility(reversed, criteria, options);
    expect(a.outcome).toBe("selected");
    expect(b.outcome).toBe("selected");
    if (a.outcome === "selected" && b.outcome === "selected") {
      expect(a.facility.facilityId).toBe("fac_a");
      expect(b.facility.facilityId).toBe("fac_a");
    }
  });

  it("returns an explicit no-eligible-facility result when nothing qualifies", () => {
    const directory = createReturnFacilityDirectory([facility({ supportedRegions: ["us-west"] })]);
    const result = selectReturnFacility(directory, criteria, options);
    expect(result.outcome).toBe("no-eligible-facility");
  });

  it("excludes retired and not-yet-effective facilities as of the selection time", () => {
    const retired = createReturnFacilityDirectory([facility({ retiredAt: "2026-03-01T00:00:00.000Z" })]);
    expect(selectReturnFacility(retired, criteria, options).outcome).toBe("no-eligible-facility");
    const future = createReturnFacilityDirectory([facility({ effectiveAt: "2026-09-01T00:00:00.000Z" })]);
    expect(selectReturnFacility(future, criteria, options).outcome).toBe("no-eligible-facility");
  });

  it("rejects a parcel that exceeds the facility package constraints", () => {
    const directory = createReturnFacilityDirectory([facility()]);
    const result = selectReturnFacility(directory, { ...criteria, packageWeightOunces: 999 }, options);
    expect(result.outcome).toBe("no-eligible-facility");
  });

  it("captures a label-safe destination snapshot without facility secrets", () => {
    const directory = createReturnFacilityDirectory([facility()]);
    const result = selectReturnFacility(directory, criteria, options);
    expect(result.outcome).toBe("selected");
    if (result.outcome !== "selected") {
      return;
    }
    const serialized = JSON.stringify(result.snapshot);
    expect(serialized).not.toContain("ops-east@chasesets.internal");
    expect(serialized).not.toContain("EAST-42");
    expect(result.snapshot.postalAddress.city).toBe("Newark");
    expect(result.snapshot.selectionPolicyVersion).toBe("facility-selection-v1");
    expect(result.snapshot.configVersion).toBe("v1");
  });

  it("keeps a captured snapshot stable after the facility configuration changes", () => {
    const before = selectReturnFacility(
      createReturnFacilityDirectory([facility({ configVersion: "v1" })]),
      criteria,
      options,
    );
    expect(before.outcome).toBe("selected");
    if (before.outcome !== "selected") {
      return;
    }
    // A later directory revision changes the address and version; the earlier snapshot must not change.
    createReturnFacilityDirectory([
      facility({ configVersion: "v2", postalAddress: { ...facility().postalAddress, line1: "999 New Dock St" } }),
    ]);
    expect(before.snapshot.configVersion).toBe("v1");
    expect(before.snapshot.postalAddress.line1).toBe("100 Dock St");
  });

  it("customerSafeDestination exposes only display copy and region", () => {
    const directory = createReturnFacilityDirectory([facility()]);
    const result = selectReturnFacility(directory, criteria, options);
    if (result.outcome !== "selected") {
      throw new Error("expected selection");
    }
    const safe = customerSafeDestination(result.snapshot);
    expect(Object.keys(safe).sort()).toEqual(["city", "displayInstructions", "displayName", "region", "state"]);
    expect(safe.displayName).toBe("Chase Sets Returns (East)");
  });

  it("captures a seller destination from the immutable outbound origin without exposing the postal address", () => {
    const snapshot = createSellerReturnDestination({
      sellerAccountId: "acc_seller",
      postalAddress: {
        name: "Seller Returns",
        line1: "42 Seller Lane",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
      selectedAt: options.asOf,
      snapshotVersion: "outbound-shipment-origin-v1",
    });

    expect(snapshot.destinationType).toBe("seller");
    expect(snapshot.sellerAccountId).toBe("acc_seller");
    expect(customerSafeDestination(snapshot)).toEqual({
      displayName: "Seller return",
      displayInstructions: "Use the provided label and keep the carrier receipt until the return is complete.",
      region: "us",
      city: "Austin",
      state: "TX",
    });
  });
});
