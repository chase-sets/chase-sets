import { describe, expect, it } from "vitest";
import { createSellerComplianceCohortRuntime } from "./cohort-evaluation-runtime";
import { SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE } from "../domain/seller-compliance-cohort-policy";

const policy = {
  ...SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  activated: true,
  currencyCode: "USD",
  qualifyingTransactionCount: 1,
  qualifyingGrossCents: "1",
  disclosureGrossCents: "2",
  windowMonths: 1,
  lookbackMonths: 2,
  comparisonIsInclusive: true,
  saleUnit: "captured-order" as const,
  qualifyingGrossBasis: "item-gross" as const,
  refundTreatment: "exclude-refunded" as const,
  postCaptureCancellationTreatment: "exclude-cancelled" as const,
  mixedLineTreatment: "exclude-mixed" as const,
  unclassifiableTreatment: "exclude-unclassifiable" as const,
  classificationRules: [{ source: "productId" as const, value: "card" }],
};

function sale(sellerAccountId: string) {
  return {
    paymentId: `pay-${sellerAccountId}`,
    orderId: `ord-${sellerAccountId}`,
    sellerAccountId,
    saleState: "captured" as const,
    occurredAt: "2025-05-01T00:00:00.000Z",
    currencyCode: "USD",
    itemGrossCents: "1",
    shippingChargeCents: "0",
    salesTaxCents: "0",
    authenticityFeeCents: "0",
    protectionCents: "0",
    orderTotalCents: "1",
    marketplaceSalesFeeCents: "0",
    sellerItemNetCents: "1",
    sellerPayoutCents: "1",
    refundedOrderTotalCents: null,
    orderRefundCapCents: null,
    cancelledAt: null,
    captureAnomalies: [],
    refundAnomalies: [],
    reconciliationMismatches: [],
    classificationInputs: [{ productId: "card" }],
    classificationInputsVersion: 1,
    changeSequence: "1",
    revision: "1",
  };
}

function fakeRuntime(options: {
  sellers: readonly string[];
  changed?: readonly string[];
  versions?: Record<string, string>;
}) {
  const checkpoints = new Map<
    string,
    { snapshot: string; after: string | null; policyVersion: string; passStartedAt: string }
  >();
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const rows = Object.fromEntries(
    (options.sellers ?? []).map((seller) => [
      seller,
      {
        sellerAccountId: seller,
        state: "member",
        band: "none",
        version: "1",
        policyVersion: options.versions?.[seller] ?? "doc-1@2025-05-15T00:00:00.000Z",
        entryEffectiveAt: "2025-05-01T00:00:00.000Z",
        exitEffectiveAt: null,
        windowStart: "2025-05-01T00:00:00.000Z",
        windowEnd: "2025-06-01T00:00:00.000Z",
        qualifyingCount: 1,
        qualifyingGrossCents: "1",
        unclassifiableCount: 0,
        nextReevaluationAt: "2025-06-01T00:00:00.000Z",
      },
    ]),
  );
  const evaluated: string[] = [];
  let snapshot = "9";
  const changed = new Set(options.changed ?? []);
  const query = async (text: string, values: readonly unknown[] = []) => {
    queries.push({ text, values });
    if (text.includes("MAX(change_sequence)")) return { rows: [{ snapshot }], rowCount: 1 };
    if (text.startsWith("SELECT snapshot_change_sequence")) {
      const checkpoint = checkpoints.get(String(values[0]));
      return {
        rows: checkpoint
          ? [
              {
                snapshot_change_sequence: checkpoint.snapshot,
                after_seller_account_id: checkpoint.after,
                policy_version: checkpoint.policyVersion,
                pass_started_at: checkpoint.passStartedAt,
              },
            ]
          : [],
        rowCount: checkpoint ? 1 : 0,
      };
    }
    if (text.startsWith("INSERT INTO platform_operations_seller_compliance_sweep_checkpoints")) {
      checkpoints.set(String(values[0]), {
        snapshot: String(values[1]),
        after: values[2] as string | null,
        policyVersion: String(values[3]),
        passStartedAt: String(values[4]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("DELETE FROM platform_operations_seller_compliance_sweep_checkpoints")) {
      checkpoints.delete(String(values[0]));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("SELECT DISTINCT seller_account_id")) {
      const after = values.at(-2) as string | null;
      const limit = values.at(-1) as number;
      const source = text.includes("occurred_at") ? options.sellers : [...changed];
      const ids = [...source]
        .filter((seller) => after === null || seller > after)
        .sort()
        .slice(0, limit);
      return { rows: ids.map((seller_account_id) => ({ seller_account_id })), rowCount: ids.length };
    }
    if (text.includes("FROM platform_operations_seller_compliance_cohorts") && text.includes("LIMIT $2")) {
      const after = values[0] as string | null;
      const limit = values[1] as number;
      const ids = Object.keys(rows)
        .filter((seller) => after === null || seller > after)
        .sort()
        .slice(0, limit);
      return { rows: ids.map((seller_account_id) => ({ seller_account_id })), rowCount: ids.length };
    }
    if (text.includes("WHERE policy_version <> $1")) {
      const after = values[1] as string | null;
      const limit = values[2] as number;
      const ids = Object.keys(rows)
        .filter((seller) => rows[seller]!.policyVersion !== values[0] && (after === null || seller > after))
        .sort()
        .slice(0, limit);
      return { rows: ids.map((seller_account_id) => ({ seller_account_id })), rowCount: ids.length };
    }
    if (text.includes("ANY($1::text[])")) {
      const ids = values[0] as readonly string[];
      return {
        rows: ids
          .filter((seller) => rows[seller])
          .map((seller_account_id) => ({
            seller_account_id,
            policy_version: rows[seller_account_id]!.policyVersion,
          })),
        rowCount: ids.length,
      };
    }
    if (text.includes("ORDER BY occurred_at ASC")) {
      const seller = String(values[0]);
      evaluated.push(seller);
      const inWindow = (value: ReturnType<typeof sale>) =>
        Date.parse(String(values[1])) <= Date.parse(value.occurredAt) &&
        Date.parse(value.occurredAt) < Date.parse(String(values[2]));
      return {
        rows: [sale(seller)].filter(inWindow).map((value) => ({
          payment_id: value.paymentId,
          order_id: value.orderId,
          seller_account_id: seller,
          sale_state: value.saleState,
          occurred_at: new Date(value.occurredAt),
          currency_code: value.currencyCode,
          item_gross_cents: value.itemGrossCents,
          shipping_charge_cents: value.shippingChargeCents,
          sales_tax_cents: value.salesTaxCents,
          authenticity_fee_cents: value.authenticityFeeCents,
          protection_cents: value.protectionCents,
          order_total_cents: value.orderTotalCents,
          marketplace_sales_fee_cents: value.marketplaceSalesFeeCents,
          seller_item_net_cents: value.sellerItemNetCents,
          seller_payout_cents: value.sellerPayoutCents,
          refunded_order_total_cents: null,
          order_refund_cap_cents: null,
          cancelled_at: null,
          capture_anomalies: [],
          refund_anomalies: [],
          reconciliation_mismatches: [],
          classification_inputs: value.classificationInputs,
          classification_inputs_version: 1,
          change_sequence: "1",
          revision: "1",
        })),
        rowCount: 1,
      };
    }
    if (text.startsWith("SELECT seller_account_id AS")) {
      const row = rows[String(values[0])];
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (text.startsWith("SELECT seller_account_id\n       FROM platform_operations_seller_compliance_cohorts")) {
      const after = values[0] as string | null;
      const limit = values[1] as number;
      const ids = Object.keys(rows)
        .filter((seller) => after === null || seller > after)
        .sort()
        .slice(0, limit);
      return { rows: ids.map((seller_account_id) => ({ seller_account_id })), rowCount: ids.length };
    }
    if (
      text.startsWith("INSERT INTO platform_operations_seller_compliance_cohorts") ||
      text.startsWith("UPDATE platform_operations_seller_compliance_cohorts")
    )
      return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const db = { query } as never;
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as never;
  return {
    db,
    pool,
    runtime: createSellerComplianceCohortRuntime({
      db,
      pool,
      policies: {
        resolvePolicy: async () => ({ value: policy, documentId: "doc-1", effectiveFrom: "2025-05-15T00:00:00.000Z" }),
      } as never,
    }),
    evaluated,
    queries,
    bump: () => {
      snapshot = "10";
    },
  };
}

describe("seller compliance cohort runtime", () => {
  it("pages the T3 occurrence pass and keeps a completed checkpoint", async () => {
    const world = fakeRuntime({
      sellers: ["s01", "s02", "s03", "s04", "s05"],
      versions: { s01: "old", s02: "old", s03: "old", s04: "old", s05: "old" },
    });
    await world.runtime.sweep({ now: "2025-05-20T00:00:00.000Z", limit: 2 });
    await world.runtime.sweep({ now: "2025-05-20T01:00:00.000Z", limit: 2 });
    await world.runtime.sweep({ now: "2025-05-20T02:00:00.000Z", limit: 2 });
    expect(new Set(world.evaluated)).toEqual(new Set(["s01", "s02", "s03", "s04", "s05"]));
  });

  it("continues T3 under its saved snapshot when an unrelated sale changes the world", async () => {
    const world = fakeRuntime({
      sellers: ["s01", "s02", "s03"],
      versions: { s01: "old", s02: "old", s03: "old" },
    });
    await world.runtime.sweep({ now: "2025-05-20T00:00:00.000Z", limit: 1 });
    world.bump();
    await world.runtime.sweep({ now: "2025-05-20T01:00:00.000Z", limit: 1 });
    await world.runtime.sweep({ now: "2025-05-20T02:00:00.000Z", limit: 1 });
    expect(new Set(world.evaluated)).toEqual(new Set(["s01", "s02", "s03"]));
  });

  it("advances T3 occurrence by the raw page even when early sellers are already current", async () => {
    const world = fakeRuntime({
      sellers: ["s01", "s02", "s03"],
      versions: { s01: "doc-1@2025-05-15T00:00:00.000Z", s02: "doc-1@2025-05-15T00:00:00.000Z", s03: "old" },
    });
    await world.runtime.sweep({ now: "2025-05-20T00:00:00.000Z", limit: 2 });
    await world.runtime.sweep({ now: "2025-05-20T01:00:00.000Z", limit: 2 });
    expect(world.evaluated).toContain("s03");
  });

  it("pages fail-closed candidates beyond the first limit", async () => {
    const world = fakeRuntime({ sellers: ["r1", "r2", "r3"] });
    const failing = createSellerComplianceCohortRuntime({
      db: world.db,
      pool: world.pool,
      policies: {
        resolvePolicy: async () => {
          throw new Error("store unavailable");
        },
      } as never,
    });
    await expect(failing.sweep({ now: "2025-05-20T00:00:00.000Z", limit: 2 })).resolves.toBe(2);
    await expect(failing.sweep({ now: "2025-05-20T01:00:00.000Z", limit: 2 })).resolves.toBe(1);
  });

  it("resumes a T1 pass inside the recording-time window it started with", async () => {
    const world = fakeRuntime({ sellers: ["s01", "s02"], changed: ["s01", "s02"] });
    await expect(world.runtime.sweep({ now: "2025-05-20T00:00:00.000Z", limit: 1 })).resolves.toBe(1);
    // 30 hours later a window recomputed from this tick would start after both changes.
    await expect(world.runtime.sweep({ now: "2025-05-21T06:00:00.000Z", limit: 1 })).resolves.toBe(1);
    const t1Pages = world.queries
      .filter((entry) => entry.text.includes("changed_at >= $2"))
      .map((entry) => entry.values.slice(1, 4));
    expect(t1Pages).toEqual([
      ["2025-05-19T00:00:00.000Z", "2025-05-20T00:00:00.000Z", null],
      ["2025-05-19T00:00:00.000Z", "2025-05-21T06:00:00.000Z", "s01"],
    ]);
    expect(world.evaluated).toEqual(["s01", "s02"]);
  });

  it("dates a no-new-sale exit by the window that rolled off before the tick's lookback floor", async () => {
    const world = fakeRuntime({ sellers: ["s01"] });
    // The 2025-05-01 sale is eligible through 2025-07-01, so it lies before this tick's 2025-05-02 floor.
    await expect(world.runtime.evaluateSeller("s01", "2025-07-02T00:00:00.000Z")).resolves.toBe(true);
    const update = world.queries.find((entry) =>
      entry.text.startsWith("UPDATE platform_operations_seller_compliance_cohorts"),
    );
    expect(update?.values.slice(1, 5)).toEqual(["outside", "none", null, "2025-07-01T00:00:00.001Z"]);
    const exited = world.queries.find((entry) =>
      entry.text.startsWith("INSERT INTO platform_operations_seller_compliance_cohort_transitions"),
    );
    expect(exited?.values.slice(0, 6)).toEqual([
      "s01:2:exited",
      "s01",
      "2",
      "exited",
      "2025-07-01T00:00:00.001Z",
      "2025-07-02T00:00:00.000Z",
    ]);
  });
});
