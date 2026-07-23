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
        contactEmail: "seller@example.test",
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

  describe("money amount validation", () => {
    it("rejects a negative configured platform balance", () => {
      expect(() => createFakeMoneyMovementGateway({ availableAmount: "-1.00" })).toThrow(
        "Platform balance must be a non-negative amount.",
      );
    });

    it("rejects a malformed configured platform balance", () => {
      expect(() => createFakeMoneyMovementGateway({ availableAmount: "abc" })).toThrow(
        "Platform balance must be a non-negative amount.",
      );
    });

    it("rejects a platform balance with more than two decimal places", () => {
      expect(() => createFakeMoneyMovementGateway({ availableAmount: "12.999" })).toThrow(
        "Platform balance must be a non-negative amount.",
      );
    });

    it("rejects a negative transfer amount", async () => {
      const gateway = createFakeMoneyMovementGateway({ availableAmount: "5.00" });

      await expect(
        gateway.transferPlatformBalanceToConnectedAccount({
          payoutId: "pyo_negative" as never,
          accountId: "acc_seller" as never,
          providerReference: "acct_fake",
          amount: "-1.00",
          currencyCode: "usd",
          idempotencyKey: "transfer-negative-key",
        }),
      ).rejects.toThrow("Transfer amount must be a non-negative amount.");
    });

    it("rejects a transfer amount with more than two decimal places", async () => {
      const gateway = createFakeMoneyMovementGateway({ availableAmount: "5.00" });

      await expect(
        gateway.transferPlatformBalanceToConnectedAccount({
          payoutId: "pyo_precision" as never,
          accountId: "acc_seller" as never,
          providerReference: "acct_fake",
          amount: "1.999",
          currencyCode: "usd",
          idempotencyKey: "transfer-precision-key",
        }),
      ).rejects.toThrow("Transfer amount must be a non-negative amount.");
    });

    it("accepts a zero-amount transfer and leaves the platform balance unchanged", async () => {
      const gateway = createFakeMoneyMovementGateway({ availableAmount: "5.00" });

      await expect(
        gateway.transferPlatformBalanceToConnectedAccount({
          payoutId: "pyo_zero" as never,
          accountId: "acc_seller" as never,
          providerReference: "acct_fake",
          amount: "0.00",
          currencyCode: "usd",
          idempotencyKey: "transfer-zero-key",
        }),
      ).resolves.toMatchObject({ providerStatus: "paid" });
      await expect(gateway.retrievePlatformBalance({ currencyCode: "usd" })).resolves.toMatchObject({
        availableAmount: "5.00",
      });
    });
  });
});
