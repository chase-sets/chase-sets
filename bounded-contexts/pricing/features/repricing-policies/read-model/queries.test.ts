import { describe, expect, it } from "vitest";
import {
  getInventoryAcquisitionCostAmount,
  getRepricingPolicy,
  listAccountRepricingPolicies,
  listRepricingPolicyAssignments,
} from "./queries";

const rule = {
  conditions: [],
  directive: {
    anchorChain: [{ source: "market-estimate" }],
    offset: { mode: "percent", percent: -1 },
    floor: { mode: "absolute", amount: "1.00" },
    ceiling: null,
    tolerance: { mode: "percent", percent: 2 },
    rounding: { mode: "none" },
    maxMovePercent: null,
    terminal: { kind: "hold" },
  },
};

function dbReturning(rows: readonly Record<string, unknown>[]) {
  return { query: async <T>() => ({ rows: rows as T[] }) };
}

describe("getRepricingPolicy", () => {
  it("returns null when no row matches", async () => {
    expect(await getRepricingPolicy(dbReturning([]), "rpp_missing")).toBeNull();
  });

  it("maps a catalog-filter scope row, parsing rules stored as a JSON string", async () => {
    const record = await getRepricingPolicy(
      dbReturning([
        {
          policy_id: "rpp_1",
          seller_account_id: "acc_1",
          name: "Electronics only",
          status: "active",
          scope_kind: "catalog-filter",
          scope_category_ids: ["cat_electronics"],
          scope_listing_ids: null,
          excluded_listing_ids: ["lst_9"],
          rules: JSON.stringify([rule]),
          max_changes_per_day: 5,
          created_at: "2026-07-11T00:00:00.000Z",
          updated_at: "2026-07-11T00:00:00.000Z",
        },
      ]),
      "rpp_1",
    );

    expect(record).toEqual({
      policyId: "rpp_1",
      sellerAccountId: "acc_1",
      name: "Electronics only",
      status: "active",
      scope: { kind: "catalog-filter", categoryIds: ["cat_electronics"] },
      excludedListingIds: ["lst_9"],
      rules: [rule],
      maxChangesPerDay: 5,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    });
  });

  it("maps a listing-set scope row", async () => {
    const record = await getRepricingPolicy(
      dbReturning([
        {
          policy_id: "rpp_2",
          seller_account_id: "acc_1",
          name: "Slabs",
          status: "paused",
          scope_kind: "listing-set",
          scope_category_ids: null,
          scope_listing_ids: ["lst_1", "lst_2"],
          excluded_listing_ids: [],
          rules: [rule],
          max_changes_per_day: 3,
          created_at: "2026-07-11T00:00:00.000Z",
          updated_at: "2026-07-11T00:00:00.000Z",
        },
      ]),
      "rpp_2",
    );

    expect(record?.scope).toEqual({ kind: "listing-set", listingIds: ["lst_1", "lst_2"] });
    expect(record?.status).toBe("paused");
  });
});

describe("listAccountRepricingPolicies", () => {
  it("excludes deleted policies by default", async () => {
    let capturedSql = "";
    let capturedParams: readonly unknown[] = [];
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        capturedSql = sql;
        capturedParams = params ?? [];
        return { rows: [] };
      },
    };
    await listAccountRepricingPolicies(db, { accountId: "acc_1" });
    expect(capturedSql).toContain("status <> 'deleted'");
    expect(capturedParams).toEqual(["acc_1", false]);
  });
});

describe("listRepricingPolicyAssignments", () => {
  it("requires accountId and/or policyId", async () => {
    await expect(listRepricingPolicyAssignments(dbReturning([]), {})).rejects.toThrow(
      "requires accountId and/or policyId",
    );
  });

  it("maps assignment rows", async () => {
    const rows = await listRepricingPolicyAssignments(
      dbReturning([
        {
          seller_account_id: "acc_1",
          listing_id: "lst_1",
          policy_id: "rpp_1",
          scope_specificity: 2,
          assigned_policy_updated_at: "2026-07-11T00:00:00.000Z",
        },
      ]),
      { accountId: "acc_1" },
    );
    expect(rows).toEqual([
      {
        sellerAccountId: "acc_1",
        listingId: "lst_1",
        policyId: "rpp_1",
        scopeSpecificity: 2,
        assignedPolicyUpdatedAt: "2026-07-11T00:00:00.000Z",
      },
    ]);
  });
});

describe("getInventoryAcquisitionCostAmount", () => {
  it("returns null when Inventory has no cost-basis fact for the item", async () => {
    const result = await getInventoryAcquisitionCostAmount(dbReturning([]), {
      sellerAccountId: "acc_1",
      catalogItemId: "cat_1",
      productId: "cat_1::",
    });
    expect(result).toBeNull();
  });

  it("returns the acquisition cost amount when present", async () => {
    const result = await getInventoryAcquisitionCostAmount(dbReturning([{ acquisition_cost_amount: "8.00" }]), {
      sellerAccountId: "acc_1",
      catalogItemId: "cat_1",
      productId: "cat_1::",
    });
    expect(result).toBe("8.00");
  });
});
