import { describe, expect, it } from "vitest";
import type {
  CreatedPayoutAccountManagementSession,
  CreatedPayoutSetupSession,
  ProviderPayoutReadiness,
} from "./index";

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

  it("represents embedded payout setup and account management sessions without provider component names", () => {
    const readiness = {
      providerReference: "acct_test",
      onboardingStatus: "pending",
      transferCapabilityStatus: "active",
      payoutCapabilityStatus: "pending",
      payoutDestinationStatus: "missing",
      missingRequirements: ["external_account"],
    } satisfies ProviderPayoutReadiness;
    const setupSession = {
      providerReference: "acct_test",
      clientSecret: "sess_secret_setup",
      expiresAt: "2026-06-01T15:00:00.000Z",
      components: ["payout-setup"],
      readiness,
    } satisfies CreatedPayoutSetupSession;
    const managementSession = {
      providerReference: "acct_test",
      clientSecret: "sess_secret_manage",
      expiresAt: null,
      components: ["payout-account-management"],
    } satisfies CreatedPayoutAccountManagementSession;

    expect(setupSession.components).toEqual(["payout-setup"]);
    expect(setupSession.readiness.missingRequirements).toEqual(["external_account"]);
    expect(managementSession.components).toEqual(["payout-account-management"]);
  });
});
