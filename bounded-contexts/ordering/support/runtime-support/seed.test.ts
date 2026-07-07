import { describe, expect, it, vi } from "vitest";
import { reputationReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import { OrderingDomainError } from "../../features/orders/domain/common";
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
      await seedOrderingDatabase(
        {} as never,
        {
          db,
          orders: {
            createOrdersFromCheckout,
            createOrdersFromAcceptedOffer,
            cancelPurchase,
          },
          postagePolicies: { commandHandler },
        } as never,
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(createOrdersFromCheckout).not.toHaveBeenCalled();
    expect(createOrdersFromAcceptedOffer).not.toHaveBeenCalled();
    expect(cancelPurchase).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Ordering seed is waiting for active Marketplace supply for Pikachu.");
    expect(logs.join("\n")).toContain("Ordering seed complete!");
  });

  it("waits for accepted-offer input projections before creating dependent seed orders", async () => {
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
                exists: values?.[0] === orderingReservedSeedIds.orders.checkoutPending,
              },
            ],
          };
        }
        if (sql.includes("SELECT status FROM ordering_order_pages")) {
          return { rows: [{ status: "cancelled" }] };
        }
        if (sql.includes("SELECT EXISTS(SELECT 1 FROM ordering_postage_policy_pages")) {
          return { rows: [{ exists: true }] };
        }
        if (sql.includes("FROM ordering_order_pages") && sql.includes("source_type = $1")) {
          return { rows: [] };
        }
        if (sql.includes("FROM ordering_offer_acceptance_inputs")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected seed query: ${sql}`);
      }),
    };

    try {
      await seedOrderingDatabase(
        {} as never,
        {
          db,
          orders: {
            createOrdersFromCheckout,
            createOrdersFromAcceptedOffer,
            cancelPurchase,
          },
          postagePolicies: { commandHandler },
        } as never,
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(createOrdersFromCheckout).not.toHaveBeenCalled();
    expect(createOrdersFromAcceptedOffer).not.toHaveBeenCalled();
    expect(cancelPurchase).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(
      "Ordering seed is waiting for active Marketplace supply for Twilight Masquerade Elite Trainer Box. Skipping the dependent accepted-offer order for this pass.",
    );
    expect(logs.join("\n")).toContain("Ordering seed complete!");
  });

  it("skips accepted-offer seed orders when active supply is not ready", async () => {
    const createOrdersFromCheckout = vi.fn();
    const createOrdersFromAcceptedOffer = vi.fn(async (params: { itemTitle: string }) => {
      throw new OrderingDomainError(`Not enough active supply is available for ${params.itemTitle}.`);
    });
    const cancelPurchase = vi.fn();
    const commandHandler = vi.fn();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    const acceptedOfferInput = {
      product_id: "prd_seed",
      marketplace_sales_fee_unit_amount: "4.00",
      seller_net_unit_amount: "40.00",
      terms_schedule_id: "trs_seed",
      terms_agreement_id: "tag_seed",
      terms_resolved_at: "2026-01-01T00:00:00.000Z",
    };
    const db = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes("SELECT EXISTS(SELECT 1 FROM ordering_order_pages")) {
          return {
            rows: [
              {
                exists: values?.[0] === orderingReservedSeedIds.orders.checkoutPending,
              },
            ],
          };
        }
        if (sql.includes("SELECT status FROM ordering_order_pages")) {
          return { rows: [{ status: "cancelled" }] };
        }
        if (sql.includes("SELECT EXISTS(SELECT 1 FROM ordering_postage_policy_pages")) {
          return { rows: [{ exists: true }] };
        }
        if (sql.includes("FROM ordering_order_pages") && sql.includes("source_type = $1")) {
          return { rows: [] };
        }
        if (sql.includes("FROM ordering_offer_acceptance_inputs")) {
          return { rows: [acceptedOfferInput] };
        }
        throw new Error(`Unexpected seed query: ${sql}`);
      }),
    };

    try {
      await seedOrderingDatabase(
        {} as never,
        {
          db,
          orders: {
            createOrdersFromCheckout,
            createOrdersFromAcceptedOffer,
            cancelPurchase,
          },
          postagePolicies: { commandHandler },
        } as never,
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(createOrdersFromCheckout).not.toHaveBeenCalled();
    expect(createOrdersFromAcceptedOffer).toHaveBeenCalledTimes(2);
    expect(cancelPurchase).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(
      "Ordering seed is waiting for active Marketplace supply for Twilight Masquerade Elite Trainer Box. Skipping the dependent accepted-offer order for this pass.",
    );
    expect(logs.join("\n")).toContain("Ordering seed complete!");
  });
});
