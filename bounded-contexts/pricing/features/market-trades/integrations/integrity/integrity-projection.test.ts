import { describe, expect, it } from "vitest";
import {
  buildPricingMarketTradesAuthenticityIntegrityProjectionHandlers,
  buildPricingMarketTradesIdentityIntegrityProjectionHandlers,
  buildPricingMarketTradesPaymentsIntegrityProjectionHandlers,
  buildPricingMarketTradesSettlementIntegrityProjectionHandlers,
} from "./integrity-projection";

type QueryCall = Readonly<{ sql: string; params: readonly unknown[] }>;

function createRecordingDb() {
  const calls: QueryCall[] = [];
  return {
    calls,
    db: {
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    },
  };
}

describe("pricing market-trades identity integrity projection", () => {
  it("excludes an account's trades with reason fraud-flagged when the manual-payout-review badge is assigned", async () => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesIdentityIntegrityProjectionHandlers(db);

    await handlers["identity.account.badge-assigned"]?.({
      type: "identity.account.badge-assigned",
      streamId: "identity.account-acct_1",
      streamVersion: 3,
      data: { badgeKey: "manual-payout-review" },
      timing: { recordedAt: "2026-07-06T00:00:00.000Z" },
    } as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("SET excluded = true");
    expect(calls[0]?.sql).toContain("exclusion_reason = 'fraud-flagged'");
    expect(calls[0]?.sql).toContain("WHERE (seller_account_id = $1 OR buyer_account_id = $1)");
    expect(calls[0]?.sql).toContain("excluded = false OR exclusion_reason = 'self-dealing'");
    expect(calls[0]?.sql).toContain("pricing_market_trade_rollup_rederive_queue");
    expect(calls[0]?.params).toEqual(["acct_1", "2026-07-06T00:00:00.000Z"]);
  });

  it.each(["trusted-seller", "founding-account"] as const)("ignores the %s badge assignment", async (badgeKey) => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesIdentityIntegrityProjectionHandlers(db);

    await handlers["identity.account.badge-assigned"]?.({
      type: "identity.account.badge-assigned",
      streamId: "identity.account-acct_1",
      streamVersion: 1,
      data: { badgeKey },
      timing: { recordedAt: "2026-07-06T00:00:00.000Z" },
    } as never);

    expect(calls).toHaveLength(0);
  });
});

describe("pricing market-trades settlement linkage projection", () => {
  const clusterHash = "a".repeat(64);

  it("projects a flag and applies pair-scoped self-dealing exclusion before queuing affected days", async () => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesSettlementIntegrityProjectionHandlers(db);

    await handlers["settlement.account-linkage.flagged"]?.({
      type: "settlement.account-linkage.flagged",
      streamId: `settlement.account-linkage-${clusterHash}`,
      streamVersion: 1,
      data: { clusterHash, signalKind: "shared-instrument", accountIds: ["acc_b", "acc_a"] },
      timing: { recordedAt: "2026-07-06T00:00:00.000Z" },
    } as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("INSERT INTO pricing_market_trade_linkage_clusters");
    expect(calls[0]?.sql).toContain("buyer_account_id = ANY($3::text[])");
    expect(calls[0]?.sql).toContain("seller_account_id = ANY($3::text[])");
    expect(calls[0]?.sql).toContain("WHERE excluded = false");
    expect(calls[0]?.sql).toContain("exclusion_reason = 'self-dealing'");
    expect(calls[0]?.sql).toContain("pricing_market_trade_rollup_rederive_queue");
    expect(calls[0]?.params).toEqual([
      clusterHash,
      "shared-instrument",
      ["acc_a", "acc_b"],
      "2026-07-06T00:00:00.000Z",
    ]);
  });

  it("clears local state and restores only self-dealing rows not covered by another active cluster", async () => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesSettlementIntegrityProjectionHandlers(db);

    await handlers["settlement.account-linkage.cleared"]?.({
      type: "settlement.account-linkage.cleared",
      streamId: `settlement.account-linkage-${clusterHash}`,
      streamVersion: 2,
      data: { clusterHash, signalKind: "shared-address", accountIds: ["acc_a", "acc_b"] },
      timing: { recordedAt: "2026-07-07T00:00:00.000Z" },
    } as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("flagged = false");
    expect(calls[0]?.sql).toContain("trade.exclusion_reason = 'self-dealing'");
    expect(calls[0]?.sql).toContain("cluster.cluster_hash <> $1");
    expect(calls[0]?.sql).toContain("SET excluded = false");
  });
});

describe("pricing market-trades payments integrity projection", () => {
  it("excludes every trade on a Stripe-flagged order with reason fraud-flagged", async () => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesPaymentsIntegrityProjectionHandlers(db);

    await handlers["payments.payment-fraud-warning-received"]?.({
      type: "payments.payment-fraud-warning-received",
      streamId: "payments.payment-pay_1",
      streamVersion: 1,
      data: { orderIds: ["ord_1", "ord_2"], receivedAt: "2026-07-06T00:00:00.000Z" },
      timing: { recordedAt: "2026-07-06T00:00:00.000Z" },
    } as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("WHERE order_id = ANY($1::text[])");
    expect(calls[0]?.sql).toContain("exclusion_reason = 'fraud-flagged'");
    expect(calls[0]?.params).toEqual([["ord_1", "ord_2"], "2026-07-06T00:00:00.000Z"]);
  });

  it("no-ops when the fraud warning carries no order ids", async () => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesPaymentsIntegrityProjectionHandlers(db);

    await handlers["payments.payment-fraud-warning-received"]?.({
      type: "payments.payment-fraud-warning-received",
      streamId: "payments.payment-pay_1",
      streamVersion: 1,
      data: { orderIds: [], receivedAt: "2026-07-06T00:00:00.000Z" },
      timing: { recordedAt: "2026-07-06T00:00:00.000Z" },
    } as never);

    expect(calls).toHaveLength(0);
  });
});

describe("pricing market-trades authenticity integrity projection", () => {
  it("records the caseId -> orderId correlation when a case opens", async () => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesAuthenticityIntegrityProjectionHandlers(db);

    await handlers["authenticity.case.opened"]?.({
      type: "authenticity.case.opened",
      streamId: "authenticity.case-case_1",
      streamVersion: 1,
      data: { caseId: "case_1", orderId: "ord_1", openedAt: "2026-07-06T00:00:00.000Z" },
      timing: { recordedAt: "2026-07-06T00:00:00.000Z" },
    } as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("INSERT INTO pricing_market_trade_authenticity_cases");
    expect(calls[0]?.params).toEqual(["case_1", "ord_1", "2026-07-06T00:00:00.000Z"]);
  });

  it("sets verified on the case's order when the verdict passes", async () => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesAuthenticityIntegrityProjectionHandlers(db);

    await handlers["authenticity.case.verdict-recorded"]?.({
      type: "authenticity.case.verdict-recorded",
      streamId: "authenticity.case-case_1",
      streamVersion: 2,
      data: {
        caseId: "case_1",
        verdict: "passed",
        reasonCodes: [],
        checklistResults: [],
        evidencePhotoRefs: [],
        lineNotes: [],
        inspectorAccountId: "inspector_1",
        decidedAt: "2026-07-07T00:00:00.000Z",
      },
      timing: { recordedAt: "2026-07-07T00:00:00.000Z" },
    } as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("SET verified = true");
    expect(calls[0]?.sql).toContain("SELECT order_id FROM pricing_market_trade_authenticity_cases WHERE case_id = $1");
    expect(calls[0]?.params).toEqual(["case_1", "2026-07-07T00:00:00.000Z"]);
  });

  it.each(["failed", "inconclusive"] as const)("does not react to a %s verdict", async (verdict) => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesAuthenticityIntegrityProjectionHandlers(db);

    await handlers["authenticity.case.verdict-recorded"]?.({
      type: "authenticity.case.verdict-recorded",
      streamId: "authenticity.case-case_1",
      streamVersion: 2,
      data: {
        caseId: "case_1",
        verdict,
        reasonCodes: [],
        checklistResults: [],
        evidencePhotoRefs: [],
        lineNotes: [],
        inspectorAccountId: "inspector_1",
        decidedAt: "2026-07-07T00:00:00.000Z",
      },
      timing: { recordedAt: "2026-07-07T00:00:00.000Z" },
    } as never);

    expect(calls).toHaveLength(0);
  });
});
