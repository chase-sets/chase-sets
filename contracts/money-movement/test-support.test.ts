import { describe, expect, it } from "vitest";
import type { MoneyMovementGateway } from "./index";
import { createFakeMoneyMovementGateway } from "./test-support";

function expectGateway(_gateway: MoneyMovementGateway) {
  return true;
}

describe("fake money movement gateway", () => {
  it("satisfies the money movement gateway contract", async () => {
    const gateway = createFakeMoneyMovementGateway();

    expect(expectGateway(gateway)).toBe(true);
    await expect(
      gateway.ensurePayoutAccount({
        accountId: "acc_seller" as never,
        currencyCode: "usd",
        idempotencyKey: "account-key",
      }),
    ).resolves.toMatchObject({
      onboardingStatus: "complete",
      transferCapabilityStatus: "active",
      payoutCapabilityStatus: "active",
      payoutDestinationStatus: "ready",
      payoutAccountDashboard: "none",
      requirementsCollector: "application",
    });
    await expect(
      gateway.createPayoutSetupSession({
        accountId: "acc_seller" as never,
        providerReference: "acct_fake",
        idempotencyKey: "embedded-setup-key",
      }),
    ).resolves.toMatchObject({
      providerReference: "acct_fake",
      clientSecret: "fake_payout_setup_secret_acct_fake",
      components: ["payout-setup"],
      readiness: {
        payoutDestinationStatus: "ready",
      },
    });
    await expect(
      gateway.createPayoutAccountManagementSession({
        accountId: "acc_seller" as never,
        providerReference: "acct_fake",
        idempotencyKey: "embedded-manage-key",
      }),
    ).resolves.toMatchObject({
      providerReference: "acct_fake",
      clientSecret: "fake_payout_account_management_secret_acct_fake",
      components: ["payout-account-management"],
    });
  });

  it("tracks idempotency keys and rejects insufficient platform balance", async () => {
    const gateway = createFakeMoneyMovementGateway({ availableAmount: "5.00" });

    await expect(
      gateway.transferPlatformBalanceToConnectedAccount({
        payoutId: "pyo_1" as never,
        accountId: "acc_seller" as never,
        providerReference: "acct_fake",
        amount: "6.00",
        currencyCode: "usd",
        idempotencyKey: "transfer-key",
      }),
    ).rejects.toThrow("Platform balance is too low for this payout.");
    expect(gateway.usedIdempotencyKeys).toContain("transfer-key");
  });
});
