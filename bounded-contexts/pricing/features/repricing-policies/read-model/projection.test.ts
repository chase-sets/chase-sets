import { describe, expect, it } from "vitest";
import { buildRepricingPolicyProjectionHandlers, repricingPolicyStreamId } from "./projection";

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

function trackedDb() {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const db = {
    query: async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return { rows: [] };
    },
  };
  return { db, calls };
}

describe("repricingPolicyStreamId", () => {
  it("prefixes the stream id consistently for projection handlers to reverse", () => {
    expect(repricingPolicyStreamId("rpp_1")).toBe("pricing.repricing-policy-rpp_1");
  });
});

describe("pricing repricing-policy projection", () => {
  it("inserts a new policy page on creation with scope columns for an all-listings scope", async () => {
    const { db, calls } = trackedDb();
    const handlers = buildRepricingPolicyProjectionHandlers(db);

    await handlers["pricing.repricing-policy.created"]?.({
      type: "pricing.repricing-policy.created",
      streamId: "pricing.repricing-policy-rpp_1",
      data: {
        policyId: "rpp_1",
        accountId: "acc_1",
        name: "Base policy",
        scope: { kind: "all-listings" },
        excludedListingIds: [],
        rules: [rule],
        maxChangesPerDay: 25,
        createdAt: "2026-07-11T00:00:00.000Z",
      },
    } as never);

    expect(calls[0]?.sql).toContain("INSERT INTO pricing_repricing_policies");
    expect(calls[0]?.params).toEqual([
      "rpp_1",
      "acc_1",
      "Base policy",
      "all-listings",
      null,
      null,
      [],
      JSON.stringify([rule]),
      25,
      "2026-07-11T00:00:00.000Z",
    ]);
  });

  it("stores catalog-filter scope columns", async () => {
    const { db, calls } = trackedDb();
    const handlers = buildRepricingPolicyProjectionHandlers(db);

    await handlers["pricing.repricing-policy.created"]?.({
      type: "pricing.repricing-policy.created",
      streamId: "pricing.repricing-policy-rpp_2",
      data: {
        policyId: "rpp_2",
        accountId: "acc_1",
        name: "Electronics only",
        scope: { kind: "catalog-filter", categoryIds: ["cat_electronics"] },
        excludedListingIds: ["lst_9"],
        rules: [rule],
        maxChangesPerDay: 5,
        createdAt: "2026-07-11T00:00:00.000Z",
      },
    } as never);

    expect(calls[0]?.params).toEqual([
      "rpp_2",
      "acc_1",
      "Electronics only",
      "catalog-filter",
      ["cat_electronics"],
      null,
      ["lst_9"],
      JSON.stringify([rule]),
      5,
      "2026-07-11T00:00:00.000Z",
    ]);
  });

  it("updates policy fields on revision, deriving the policy id from the stream id", async () => {
    const { db, calls } = trackedDb();
    const handlers = buildRepricingPolicyProjectionHandlers(db);

    await handlers["pricing.repricing-policy.revised"]?.({
      type: "pricing.repricing-policy.revised",
      streamId: "pricing.repricing-policy-rpp_1",
      data: {
        name: "Base policy v2",
        scope: { kind: "listing-set", listingIds: ["lst_1", "lst_2"] },
        excludedListingIds: [],
        rules: [rule],
        maxChangesPerDay: 10,
        revisedAt: "2026-07-12T00:00:00.000Z",
      },
    } as never);

    expect(calls[0]?.sql).toContain("UPDATE pricing_repricing_policies");
    expect(calls[0]?.params).toEqual([
      "rpp_1",
      "Base policy v2",
      "listing-set",
      null,
      ["lst_1", "lst_2"],
      [],
      JSON.stringify([rule]),
      10,
      "2026-07-12T00:00:00.000Z",
    ]);
  });

  it("sets status to paused/active/deleted for the corresponding lifecycle events", async () => {
    const { db, calls } = trackedDb();
    const handlers = buildRepricingPolicyProjectionHandlers(db);

    await handlers["pricing.repricing-policy.paused"]?.({
      type: "pricing.repricing-policy.paused",
      streamId: "pricing.repricing-policy-rpp_1",
      data: { pausedAt: "2026-07-13T00:00:00.000Z" },
    } as never);
    await handlers["pricing.repricing-policy.resumed"]?.({
      type: "pricing.repricing-policy.resumed",
      streamId: "pricing.repricing-policy-rpp_1",
      data: { resumedAt: "2026-07-14T00:00:00.000Z" },
    } as never);
    await handlers["pricing.repricing-policy.deleted"]?.({
      type: "pricing.repricing-policy.deleted",
      streamId: "pricing.repricing-policy-rpp_1",
      data: { deletedAt: "2026-07-15T00:00:00.000Z" },
    } as never);

    expect(calls[0]?.sql).toContain("status = 'paused'");
    expect(calls[0]?.params).toEqual(["rpp_1", "2026-07-13T00:00:00.000Z"]);
    expect(calls[1]?.sql).toContain("status = 'active'");
    expect(calls[1]?.params).toEqual(["rpp_1", "2026-07-14T00:00:00.000Z"]);
    expect(calls[2]?.sql).toContain("status = 'deleted'");
    expect(calls[2]?.params).toEqual(["rpp_1", "2026-07-15T00:00:00.000Z"]);
  });
});
