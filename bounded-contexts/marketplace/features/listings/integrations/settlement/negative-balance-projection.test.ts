import { describe, expect, it, vi } from "vitest";
import { buildMarketplaceSettlementNegativeBalanceProjectionHandlers } from "./negative-balance-projection";

describe("marketplace settlement negative-balance projection", () => {
  it("disables seller listing availability when Settlement opens collections", async () => {
    const listings = {
      disableSellerListingAvailability: vi.fn(async () => ({
        accountId: "acc_seller",
        version: 1,
        status: "unavailable" as const,
      })),
    };
    const handlers = buildMarketplaceSettlementNegativeBalanceProjectionHandlers(listings);

    const event = {
      id: "evt_01JNEGATIVEBALANCE00000001",
      data: {
        accountId: "acc_seller",
        balanceAmount: "-125.00",
        negativeSince: "2026-04-02T00:02:00.000Z",
        thresholdAmount: "100.00",
        gracePeriodDays: 14,
        openedAt: "2026-04-16T00:02:00.000Z",
      },
    } as never;
    await handlers["settlement.wallet.negative-balance-collections-opened"]!(event);
    // A projection replay of the same source fact carries the same attempt, so Marketplace replays its receipt.
    await handlers["settlement.wallet.negative-balance-collections-opened"]!(event);

    expect(listings.disableSellerListingAvailability).toHaveBeenCalledWith(
      {
        accountId: "acc_seller",
        reasonCategory: "operations",
        availableAgainOn: null,
        availableAgainAt: null,
        idempotencyKey: "negative-balance_evt_01JNEGATIVEBALANCE00000001",
      },
      expect.objectContaining({
        tenantId: "tnt_marketplace_system",
        audit: expect.objectContaining({
          forAccountId: "acc_seller",
        }),
      }),
    );
    const [first, second] = listings.disableSellerListingAvailability.mock.calls as unknown as [unknown[], unknown[]];
    expect(second[0]).toEqual(first[0]);
  });
});
