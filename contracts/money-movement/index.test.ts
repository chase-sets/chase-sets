import { describe, expect, it } from "vitest";
import type {
  CreatedPayoutAccountManagementSession,
  CreatedPayoutSetupLink,
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
      payoutAccountDashboard: "none",
      lossesCollector: "application",
      feesCollector: "application",
      requirementsCollector: "application",
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
      payoutAccountDashboard: "express",
      lossesCollector: "application",
      feesCollector: "application",
      requirementsCollector: "stripe",
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
    expect(setupSession.readiness.payoutAccountDashboard).toBe("express");
    expect(managementSession.components).toEqual(["payout-account-management"]);
  });

  it("represents hosted payout setup links without exposing provider secrets", () => {
    const readiness = {
      providerReference: "acct_test",
      onboardingStatus: "pending",
      transferCapabilityStatus: "pending",
      payoutCapabilityStatus: "pending",
      payoutDestinationStatus: "missing",
      payoutAccountDashboard: "none",
      lossesCollector: "application",
      feesCollector: "application",
      requirementsCollector: "application",
      missingRequirements: ["provider-onboarding"],
    } satisfies ProviderPayoutReadiness;
    const setupLink = {
      providerReference: "acct_test",
      url: "https://connect.stripe.com/setup/c/acct_test/link_test",
      expiresAt: "2026-06-01T15:00:00.000Z",
      readiness,
    } satisfies CreatedPayoutSetupLink;

    expect(setupLink.url).toMatch(/^https:\/\//);
    expect("clientSecret" in setupLink).toBe(false);
    expect(setupLink.readiness.onboardingStatus).toBe("pending");
  });
});
