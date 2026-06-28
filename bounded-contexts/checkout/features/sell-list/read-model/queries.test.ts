import { describe, expect, it } from "vitest";

import { getLatestSellListConfirmation, getSellPayoutReadiness } from "./queries";

describe("sell list confirmation queries", () => {
  it("reads only fresh confirmation pages", async () => {
    const queriedSql: string[] = [];
    const db = {
      query: async (sql: string) => {
        queriedSql.push(sql);
        return {
          rows: [
            {
              seller_account_id: "acc_seller",
              confirmation_id: "slc_1",
              confirmed_at: "2026-06-09T00:00:00.000Z",
              readiness_evidence: { snapshotId: "slr_ready" },
              seller_evidence: { shipFrom: { status: "ready" } },
              handoff_summary: { acceptedOfferCount: 1 },
            },
          ],
        };
      },
    };

    await expect(getLatestSellListConfirmation(db, "acc_seller")).resolves.toEqual({
      seller_account_id: "acc_seller",
      confirmation_id: "slc_1",
      confirmed_at: "2026-06-09T00:00:00.000Z",
      readiness_evidence: { snapshotId: "slr_ready" },
      seller_evidence: { shipFrom: { status: "ready" } },
      handoff_summary: { acceptedOfferCount: 1 },
    });
    expect(queriedSql.join("\n")).toContain("checkout_sell_list_confirmation_pages");
    expect(queriedSql.join("\n")).not.toContain("checkout_sell_list_execution_pages");
    expect(queriedSql.join("\n")).not.toContain("checkout_sell_list_receipt_pages");
  });

  it("does not query old receipt tables when no confirmation exists", async () => {
    const queriedSql: string[] = [];
    const db = {
      query: async (sql: string) => {
        queriedSql.push(sql);
        return { rows: [] };
      },
    };

    await expect(getLatestSellListConfirmation(db, "acc_seller")).resolves.toBeNull();
    expect(queriedSql).toHaveLength(1);
    expect(queriedSql[0]).toContain("checkout_sell_list_confirmation_pages");
    expect(queriedSql[0]).not.toContain("checkout_sell_list_execution_pages");
    expect(queriedSql[0]).not.toContain("checkout_sell_list_receipt_pages");
  });

  it("reads Checkout-owned sell payout readiness rows", async () => {
    const db = {
      query: async () => ({
        rows: [
          {
            account_id: "acc_seller",
            status: "restricted",
            missing_requirements: ["external_account"],
            updated_at: "2026-06-09T00:00:00.000Z",
          },
        ],
      }),
    };

    await expect(getSellPayoutReadiness(db, "acc_seller")).resolves.toEqual({
      account_id: "acc_seller",
      status: "restricted",
      missing_requirements: ["external_account"],
      updated_at: "2026-06-09T00:00:00.000Z",
    });
  });

  it("returns setup-required payout readiness when no local row exists yet", async () => {
    const db = {
      query: async () => ({ rows: [] }),
    };

    await expect(getSellPayoutReadiness(db, "acc_seller")).resolves.toEqual({
      account_id: "acc_seller",
      status: "not-started",
      missing_requirements: ["provider-onboarding", "seller-agreement"],
      updated_at: null,
    });
  });
});
