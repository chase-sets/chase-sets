import { describe, expect, it } from "vitest";
import type { MoneyMovementGateway } from "@chase-sets/money-movement";
import { createFakeMoneyMovementGateway } from "./index";

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
