import { describe, expect, it } from "vitest";
import { shouldDrainCatalogSeedProjectors } from "./seed";

describe("Catalog seed projector drain policy", () => {
  it("does not drain projectors for long-lived bootstrap profiles", () => {
    expect(
      shouldDrainCatalogSeedProjectors({
        enabledDataProfiles: ["critical-bootstrap", "catalog-integration-bootstrap"],
        environmentName: "staging",
      }),
    ).toBe(false);
  });

  it("keeps projector drains for scenario seed profiles", () => {
    expect(
      shouldDrainCatalogSeedProjectors({
        enabledDataProfiles: ["critical-bootstrap", "catalog-integration-bootstrap", "scenario-seed"],
        environmentName: "preview",
      }),
    ).toBe(true);
  });
});
