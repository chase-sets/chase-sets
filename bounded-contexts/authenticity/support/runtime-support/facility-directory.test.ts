import { describe, expect, it } from "vitest";
import { createPlatformOperatedFacilityDirectory } from "./facility-directory";

describe("platform-operated authenticity facility directory", () => {
  it("returns the configured facility profile regardless of the requesting order", async () => {
    const directory = createPlatformOperatedFacilityDirectory({
      facilityId: "facility_platform_1",
      operatingIdentity: "Chase Sets Authenticity Facility",
      address: {
        name: "Chase Sets Authenticity Facility",
        line1: "1 Verification Way",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
    });

    const profileForOrderA = await directory.getFacilityForCase({ orderId: "ord_1" });
    const profileForOrderB = await directory.getFacilityForCase({ orderId: "ord_2" });

    expect(profileForOrderA).toEqual(profileForOrderB);
    expect(profileForOrderA).toMatchObject({
      facilityId: "facility_platform_1",
      operatingIdentity: "Chase Sets Authenticity Facility",
      address: { city: "Chicago", state: "IL" },
    });
  });
});
