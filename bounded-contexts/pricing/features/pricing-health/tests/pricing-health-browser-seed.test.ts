import { describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  projectSyntheticPricingHealthPolicy,
  seedSyntheticPricingHealthInputs,
} from "../../../support/runtime-support/pricing-health-browser-seed";

describe("Pricing Health browser input fixture", () => {
  it("uses exact money arithmetic for quantities and the canonical curve sale probability", async () => {
    const query: PgTransactionalPool["query"] = async <Row>(sql: string) => ({
      rows: (sql.includes("FROM pricing_market_listing_inputs")
        ? [
            {
              catalog_item_id: "synthetic-item",
              product_id: "synthetic-product",
              price_amount: "19.99",
              quantity_cap: 3,
            },
          ]
        : []) as Row[],
    });
    const pool: PgTransactionalPool = { query, connect: async () => ({ query, release: () => {} }) };
    const fixture = await seedSyntheticPricingHealthInputs(pool, {
      accountId: "synthetic-account",
      listingId: "synthetic-listing",
      now: "2026-10-19T10:00:00.000Z",
    });
    expect(fixture.expected).toEqual({
      modeledValueAmount: "59.97",
      expectedSalesListingCount: 0.6321205588285577,
      expectedSalesValueAmount: "12.64",
    });
    await fixture.cleanup();
  });
});

describe("Synthetic Pricing Health policy discovery inputs", () => {
  const now = "2026-10-19T10:00:00.000Z";
  const input = { accountId: "acc_synthetic", policyId: "rpp_synthetic" };
  const created = {
    event_id: "evt_synthetic_created",
    stream_id: "pricing.repricing-policy-rpp_synthetic",
    stream_version: 1,
    global_position: "1",
    tenant_id: "tnt_synthetic",
    event_type: "pricing.repricing-policy.created",
    payload: {
      ...input,
      name: "Synthetic Pricing Health browser incumbent",
      scope: { kind: "all-listings" },
      excludedListingIds: [],
      rules: [],
      maxChangesPerDay: 25,
      createdAt: now,
    },
    metadata: {},
    occurred_at: now,
    recorded_at: now,
    performed_by_user_id: "usr_synthetic",
    for_account_id: input.accountId,
  };
  function setup(events: readonly unknown[]) {
    const writes: string[] = [];
    const query: PgTransactionalPool["query"] = async <Row>(sql: string) => {
      const reading = sql.includes("stream_version >=");
      if (!reading) writes.push(sql);
      return { rows: (reading ? events : []) as Row[] };
    };
    return { pool: { query, connect: async () => ({ query, release: () => {} }) }, writes };
  }

  it("projects actual retained creation and deletion events using the canonical handlers", async () => {
    const deleted = {
      ...created,
      event_id: "evt_synthetic_deleted",
      stream_version: 2,
      global_position: "2",
      event_type: "pricing.repricing-policy.deleted",
      payload: { deletedAt: now },
    };
    const { pool, writes } = setup([created, deleted]);
    await projectSyntheticPricingHealthPolicy(pool, input);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain("INSERT INTO pricing_repricing_policies");
    expect(writes[1]).toContain("SET status = 'deleted'");
    expect(writes.join("\n")).not.toContain("pricing_repricing_dry_runs");
  });

  it.each([
    ["missing", []],
    ["foreign", [{ ...created, payload: { ...created.payload, accountId: "acc_foreign" } }]],
    ["non-fixture", [{ ...created, payload: { ...created.payload, name: "Real seller policy" } }]],
    ["unexpected lifecycle", [created, { ...created, event_type: "pricing.repricing-policy.revised" }]],
    ["truncated", Array.from({ length: 10 }, () => created)],
  ] as const)("refuses %s streams without a projection write", async (_reason, events) => {
    const { pool, writes } = setup(events);
    await expect(projectSyntheticPricingHealthPolicy(pool, input)).rejects.toThrow("refuses");
    expect(writes).toEqual([]);
  });
});
