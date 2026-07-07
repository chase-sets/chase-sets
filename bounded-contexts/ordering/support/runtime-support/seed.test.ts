import { describe, expect, it, vi } from "vitest";
import { reputationReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import { orderingReservedSeedIds } from "../seed-support/ids";
import { seedOrderingDatabase } from "./seed";

describe("ordering seed", () => {
  it("waits for active Marketplace supply instead of failing partial preview bootstrap", async () => {
    const createOrdersFromCheckout = vi.fn();
    const createOrdersFromAcceptedOffer = vi.fn();
    const cancelPurchase = vi.fn();
    const commandHandler = vi.fn();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    const db = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes("SELECT EXISTS(SELECT 1 FROM ordering_order_pages")) {
          return {
            rows: [
              {
                exists:
                  values?.[0] === orderingReservedSeedIds.orders.acceptedOfferReady ||
                  values?.[0] === reputationReservedSeedIds.orders.reviewEligibleDelivered,
              },
            ],
          };
        }
        if (sql.includes("SELECT status FROM ordering_order_pages")) {
          return { rows: [] };
        }
        if (sql.includes("SELECT EXISTS(SELECT 1 FROM ordering_postage_policy_pages")) {
          return { rows: [{ exists: true }] };
        }
        if (sql.includes("FROM ordering_market_listing_inputs")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected seed query: ${sql}`);
      }),
    };

    try {
      await seedOrderingDatabase({} as never, {
        db,
        orders: {
          createOrdersFromCheckout,
          createOrdersFromAcceptedOffer,
          cancelPurchase,
        },
        postagePolicies: { commandHandler },
      } as never);
    } finally {
      logSpy.mockRestore();
    }

    expect(createOrdersFromCheckout).not.toHaveBeenCalled();
    expect(createOrdersFromAcceptedOffer).not.toHaveBeenCalled();
    expect(cancelPurchase).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Ordering seed is waiting for active Marketplace supply for Pikachu.");
    expect(logs.join("\n")).toContain("Ordering seed complete!");
  });
});
