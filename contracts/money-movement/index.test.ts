import { describe, expect, it } from "vitest";
import type { ProviderPayoutReadiness } from "./index";

describe("money movement contract", () => {
  it("represents a ready payout provider state", () => {
    const readiness = {
      providerReference: "acct_test",
      onboardingStatus: "complete",
      transferCapabilityStatus: "active",
      payoutCapabilityStatus: "active",
      payoutDestinationStatus: "ready",
      missingRequirements: [],
    } satisfies ProviderPayoutReadiness;

    expect(readiness).toMatchObject({
      onboardingStatus: "complete",
      payoutDestinationStatus: "ready",
    });
  });
});
