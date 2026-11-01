import { describe, expect, it } from "vitest";
import { createSellerComplianceCohortRuntime } from "./cohort-evaluation-runtime";
import {
  SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  SellerComplianceCohortPolicyDomainError,
  type SellerComplianceCohortPolicyValue,
} from "../domain/seller-compliance-cohort-policy";
import type { PolicyHistoryRecord } from "@chase-sets/platform-policy/policy-history-reader";

const policy: SellerComplianceCohortPolicyValue = {
  ...SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  activated: true,
  currencyCode: "USD",
  qualifyingTransactionCount: 1,
  qualifyingGrossCents: "1",
  disclosureGrossCents: "2",
  windowMonths: 1,
  lookbackMonths: 2,
  comparisonIsInclusive: true,
  saleUnit: "captured-order",
  qualifyingGrossBasis: "item-gross",
  refundTreatment: "exclude-refunded",
  postCaptureCancellationTreatment: "exclude-cancelled",
  mixedLineTreatment: "exclude-mixed",
  unclassifiableTreatment: "exclude-unclassifiable",
  classificationRules: [{ source: "productId", value: "card" }],
};
/** Two sales and 500000 cents enter; 2000000 cents raise the disclosure band. */
const pairPolicy: SellerComplianceCohortPolicyValue = {
  ...policy,
  qualifyingTransactionCount: 2,
  qualifyingGrossCents: "500000",
  disclosureGrossCents: "2000000",
};

type Sale = Readonly<{
  paymentId: string;
  orderId: string;
  occurredAt: string;
  currencyCode: string;
  grossCents: string;
}>;
const sale = (id: string, occurredAt: string, grossCents = "1", currencyCode = "USD"): Sale => ({
  paymentId: `pay-${id}`,
  orderId: `ord-${id}`,
  occurredAt,
  currencyCode,
  grossCents,
});
type CohortRow = Record<string, unknown> & { sellerAccountId: string; version: string; policyVersion: string };
type ResolvedFixture = Readonly<{
  value: SellerComplianceCohortPolicyValue;
  documentId: string;
  effectiveFrom: string;
}>;
type WorldSetup = Partial<ResolvedFixture> & { history?: readonly PolicyHistoryRecord[] };

/**
 * A stateful fake of every table the cohort runtime reads and writes. Each statement is matched by its exact
 * bound-parameter layout, writes persist across ticks, and an unmodelled statement fails the test.
 */
function createWorld(initial: WorldSetup = {}) {
  let resolved: ResolvedFixture = {
    value: initial.value ?? policy,
    documentId: initial.documentId ?? "doc-1",
    effectiveFrom: initial.effectiveFrom ?? "2025-01-01T00:00:00.000Z",
  };
  let resolveError: Error | null = null;
  let snapshot = 0;
  const sales: { seller: string; sale: Sale; changeSequence: number; changedAt: string }[] = [];
  const cohorts = new Map<string, CohortRow>();
  const transitions: Record<string, unknown>[] = [];
  const checkpoints = new Map<
    string,
    { snapshot: string; after: string | null; policyVersion: string; passStartedAt: string; updatedAt: string }
  >();
  const failures: unknown[][] = [];
  const evidence = new Map<string, { effectiveFrom: string; value: unknown }>();
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const evaluations: { seller: string; from: string; to: string }[] = [];
  let cohortWrites = 0;
  let recorded = 0;
  const page = (ids: Iterable<string>, after: unknown, limit: unknown) =>
    [...new Set(ids)]
      .sort()
      .filter((id) => after === null || after === undefined || id > String(after))
      .slice(0, Number(limit));
  const sellerRows = (ids: readonly string[]) => ({
    rows: ids.map((seller_account_id) => ({ seller_account_id })),
    rowCount: ids.length,
  });
  const ms = (value: unknown) => Date.parse(String(value));
  const saleRow = (seller: string, value: Sale) => ({
    payment_id: value.paymentId,
    order_id: value.orderId,
    seller_account_id: seller,
    sale_state: "captured",
    occurred_at: new Date(value.occurredAt),
    currency_code: value.currencyCode,
    item_gross_cents: value.grossCents,
    shipping_charge_cents: "0",
    sales_tax_cents: "0",
    authenticity_fee_cents: "0",
    protection_cents: "0",
    order_total_cents: value.grossCents,
    marketplace_sales_fee_cents: "0",
    seller_item_net_cents: value.grossCents,
    seller_payout_cents: value.grossCents,
    refunded_order_total_cents: null,
    order_refund_cap_cents: null,
    cancelled_at: null,
    capture_anomalies: [],
    refund_anomalies: [],
    reconciliation_mismatches: [],
    classification_inputs: [{ productId: "card" }],
    classification_inputs_version: 1,
    change_sequence: "1",
    revision: "1",
  });
  const ledgerOf = (seller: string) =>
    transitions
      .filter((row) => row.seller_account_id === seller)
      .sort((a, b) => Number(a.transition_version) - Number(b.transition_version));
  const query = async (text: string, values: readonly unknown[] = []) => {
    queries.push({ text, values });
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (text.includes("MAX(change_sequence)")) return { rows: [{ snapshot: String(snapshot) }], rowCount: 1 };
    if (text.startsWith("SELECT snapshot_change_sequence")) {
      const saved = checkpoints.get(String(values[0]));
      return {
        rows: saved
          ? [
              {
                snapshot_change_sequence: saved.snapshot,
                after_seller_account_id: saved.after,
                policy_version: saved.policyVersion,
                pass_started_at: saved.passStartedAt,
              },
            ]
          : [],
        rowCount: saved ? 1 : 0,
      };
    }
    if (text.startsWith("INSERT INTO platform_operations_seller_compliance_sweep_checkpoints")) {
      checkpoints.set(String(values[0]), {
        snapshot: String(values[1]),
        after: (values[2] ?? null) as string | null,
        policyVersion: String(values[3]),
        passStartedAt: String(values[4]),
        updatedAt: String(values[5]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("DELETE FROM platform_operations_seller_compliance_sweep_checkpoints")) {
      checkpoints.delete(String(values[0]));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("NOT EXISTS")) {
      const ids = transitions.map((row) => String(row.seller_account_id)).filter((seller) => !cohorts.has(seller));
      return sellerRows(page(ids, values[0], values[1]));
    }
    if (text.includes("DISTINCT ON (kind)")) {
      const latest = new Map<string, Record<string, unknown>>();
      for (const row of ledgerOf(String(values[0]))) latest.set(String(row.kind), row);
      const rows = [...latest.values()].map((row) => ({
        kind: row.kind,
        version: row.transition_version,
        effective_at: new Date(String(row.effective_at)),
        observed_at: new Date(String(row.observed_at)),
        policy_version: row.policy_version,
        target_state: row.target_state,
        target_band: row.target_band,
      }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes("ORDER BY transition_version DESC LIMIT 1")) {
      const row = ledgerOf(String(values[0])).at(-1);
      return {
        rows: row
          ? [{ version: row.transition_version, target_state: row.target_state, target_band: row.target_band }]
          : [],
        rowCount: row ? 1 : 0,
      };
    }
    if (text.includes("SELECT DISTINCT seller_account_id")) {
      if (text.includes("change_sequence > $1::bigint")) {
        const ids = sales
          .filter((entry) => entry.changeSequence > Number(values[0]) && entry.changeSequence <= Number(values[1]))
          .map((entry) => entry.seller);
        return sellerRows(page(ids, values[2], values[3]));
      }
      if (values.length === 6) {
        const ids = sales
          .filter((entry) => entry.changeSequence > Number(values[0]) && entry.changeSequence <= Number(values[1]))
          .filter((entry) => ms(entry.changedAt) >= ms(values[2]) && ms(entry.changedAt) < ms(values[3]))
          .map((entry) => entry.seller);
        return sellerRows(page(ids, values[4], values[5]));
      }
      const column = text.includes("changed_at >=") ? "changedAt" : "occurredAt";
      const ids = sales
        .filter((entry) => entry.changeSequence <= Number(values[0]))
        .filter((entry) => {
          const at = ms(column === "changedAt" ? entry.changedAt : entry.sale.occurredAt);
          return at >= ms(values[1]) && at < ms(values[2]);
        })
        .map((entry) => entry.seller);
      return sellerRows(page(ids, values[3], values[4]));
    }
    if (text.includes("WHERE next_reevaluation_at <= $1")) {
      const ids = [...cohorts.values()]
        .filter((row) => row.nextReevaluationAt !== null && ms(row.nextReevaluationAt) <= ms(values[0]))
        .map((row) => row.sellerAccountId);
      return sellerRows(page(ids, values[1], values[2]));
    }
    if (text.includes("WHERE policy_version <> $1")) {
      const ids = [...cohorts.values()]
        .filter((row) => row.policyVersion !== values[0])
        .map((row) => row.sellerAccountId);
      return sellerRows(page(ids, values[1], values[2]));
    }
    if (text.includes("ANY($1::text[])")) {
      const rows = (values[0] as readonly string[])
        .filter((seller) => cohorts.has(seller))
        .map((seller) => ({ seller_account_id: seller, policy_version: cohorts.get(seller)!.policyVersion }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM platform_operations_seller_compliance_cohorts") && text.includes("WHERE ($1::text IS NULL"))
      return sellerRows(page(cohorts.keys(), values[0], values[1]));
    if (text.includes("ORDER BY occurred_at ASC, payment_id ASC")) {
      const seller = String(values[0]);
      if (values[3] === null) evaluations.push({ seller, from: String(values[1]), to: String(values[2]) });
      const cursor = values[3] === null ? null : [ms(values[3]), String(values[4]), String(values[5])];
      const rows = sales
        .filter((entry) => entry.seller === seller)
        .map((entry) => entry.sale)
        .filter((value) => ms(value.occurredAt) >= ms(values[1]) && ms(value.occurredAt) < ms(values[2]))
        .sort(
          (a, b) =>
            ms(a.occurredAt) - ms(b.occurredAt) ||
            a.paymentId.localeCompare(b.paymentId) ||
            a.orderId.localeCompare(b.orderId),
        )
        .filter(
          (value) =>
            cursor === null ||
            ms(value.occurredAt) > Number(cursor[0]) ||
            (ms(value.occurredAt) === Number(cursor[0]) &&
              (value.paymentId > String(cursor[1]) ||
                (value.paymentId === cursor[1] && value.orderId > String(cursor[2])))),
        )
        .slice(0, Number(values[6]))
        .map((value) => saleRow(seller, value));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith('SELECT seller_account_id AS "sellerAccountId"')) {
      const row = cohorts.get(String(values[0]));
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    const cohortRow = (input: readonly unknown[]): CohortRow => ({
      sellerAccountId: String(input[0]),
      state: input[1],
      band: input[2],
      entryEffectiveAt: input[3],
      exitEffectiveAt: input[4],
      windowStart: input[5],
      windowEnd: input[6],
      qualifyingCount: input[7],
      qualifyingGrossCents: input[8],
      unclassifiableCount: input[9],
      policyVersion: String(input[10]),
      version: String(input[11]),
      nextReevaluationAt: input[12],
      updatedAt: input[13],
    });
    if (text.startsWith("INSERT INTO platform_operations_seller_compliance_cohorts")) {
      if (cohorts.has(String(values[0]))) return { rows: [], rowCount: 0 };
      cohortWrites += 1;
      cohorts.set(String(values[0]), cohortRow(values));
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("UPDATE platform_operations_seller_compliance_cohorts")) {
      const row = cohorts.get(String(values[0]));
      if (!row || row.version !== String(values[14])) return { rows: [], rowCount: 0 };
      cohortWrites += 1;
      cohorts.set(String(values[0]), cohortRow(values));
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO platform_operations_seller_compliance_cohort_transitions")) {
      if (transitions.some((row) => row.transition_id === values[0])) return { rows: [], rowCount: 0 };
      recorded += 1;
      transitions.push({
        transition_id: values[0],
        seller_account_id: values[1],
        transition_version: String(values[2]),
        kind: values[3],
        effective_at: values[4],
        observed_at: values[5],
        policy_version: values[6],
        target_state: values[7],
        target_band: values[8],
        recorded_at: `recorded-${recorded}`,
        published_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("INSERT INTO platform_operations_seller_compliance_evaluation_failures")) {
      const exists = failures.some((row) => row[0] === values[0] && row[1] === values[1] && row[2] === values[2]);
      if (!exists) failures.push([...values]);
      return { rows: [], rowCount: exists ? 0 : 1 };
    }
    if (text.startsWith("INSERT INTO platform_operations_seller_compliance_policy_evidence")) {
      if (evidence.has(String(values[0]))) return { rows: [], rowCount: 0 };
      evidence.set(String(values[0]), { effectiveFrom: String(values[1]), value: JSON.parse(String(values[2])) });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("FROM platform_operations_seller_compliance_policy_evidence")) {
      const rows = [...evidence.entries()]
        .filter(([, row]) => ms(row.effectiveFrom) < ms(values[0]))
        .sort(([a, left], [b, right]) => ms(left.effectiveFrom) - ms(right.effectiveFrom) || a.localeCompare(b))
        .map(([policy_version, row]) => ({
          policy_version,
          effective_from: new Date(row.effectiveFrom),
          value: row.value,
        }));
      return { rows, rowCount: rows.length };
    }
    throw new Error(`Unmodelled cohort query: ${text.slice(0, 120)}`);
  };
  const db = { query } as never;
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as never;
  const createRuntime = () =>
    createSellerComplianceCohortRuntime({
      db,
      pool,
      policies: {
        resolvePolicy: async () => {
          if (resolveError) throw resolveError;
          return { value: resolved.value, documentId: resolved.documentId, effectiveFrom: resolved.effectiveFrom };
        },
      } as never,
      policyHistory:
        initial.history === undefined
          ? undefined
          : ({
              start: async () => ({
                policyKey: "platform-operations.seller-compliance-cohort",
                horizon: "999",
                continuation: {
                  policyKey: "platform-operations.seller-compliance-cohort",
                  horizon: "999",
                  afterGlobalPosition: "0",
                },
              }),
              readPage: async () => ({
                records: initial.history ?? [],
                horizon: "999",
                continuation: {
                  policyKey: "platform-operations.seller-compliance-cohort",
                  horizon: "999",
                  afterGlobalPosition: "999",
                },
                complete: true,
              }),
            } as never),
    });
  return {
    db,
    pool,
    runtime: createRuntime(),
    createRuntime,
    cohorts,
    transitions,
    checkpoints,
    failures,
    evidence,
    queries,
    evaluations,
    cohortWrites: () => cohortWrites,
    version: () => `${resolved.documentId}@${resolved.effectiveFrom}`,
    publish: (next: Partial<ResolvedFixture>) => {
      resolved = { ...resolved, ...next };
    },
    failResolution: (error: Error) => {
      resolveError = error;
    },
    /** Records a completed sale fact and moves the snapshot, as a #7144 projection write does. */
    record: (seller: string, value: Sale, changedAt = value.occurredAt) => {
      snapshot += 1;
      sales.push({ seller, sale: value, changeSequence: snapshot, changedAt });
    },
    /** Sellers whose verdict was loaded since `mark`, each with the evaluation instant it was loaded for. */
    evaluatedSince: (mark: number) => [
      ...new Set(evaluations.slice(mark).map((entry) => `${entry.seller}@${entry.to}`)),
    ],
    sellersSince: (mark: number) => [...new Set(evaluations.slice(mark).map((entry) => entry.seller))],
    seed: (row: CohortRow) => {
      cohorts.set(row.sellerAccountId, row);
    },
    snapshotState: () =>
      JSON.parse(
        JSON.stringify({
          cohorts: [...cohorts.values()],
          transitions,
          checkpoints: [...checkpoints.entries()],
          failures,
        }),
      ) as unknown,
  };
}
type World = ReturnType<typeof createWorld>;

const historyRecord = (
  overrides: Partial<Omit<PolicyHistoryRecord, "globalPosition">> & {
    eventId: string;
    documentId: string;
    streamVersion: number;
    globalPosition: string;
  },
): PolicyHistoryRecord => ({
  eventType: "platform-policy.document.created",
  policyKey: "platform-operations.seller-compliance-cohort",
  recordedAt: "2025-01-01T00:00:00.000Z",
  status: "active",
  value: policy,
  effectiveFrom: "2025-01-01T00:00:00.000Z",
  effectiveUntil: null,
  ...overrides,
  globalPosition: overrides.globalPosition as never,
});

async function sweepTicks(world: World, ticks: readonly string[], limit: number) {
  const perTick: string[][] = [];
  for (const now of ticks) {
    const mark = world.evaluations.length;
    await world.runtime.sweep({ now, limit });
    perTick.push(world.sellersSince(mark));
  }
  return perTick;
}
const tick = (minutes: number) => new Date(Date.parse("2025-05-20T00:00:00.000Z") + minutes * 60_000).toISOString();
const ledger = (world: World, seller?: string) =>
  world.transitions
    .filter((row) => seller === undefined || row.seller_account_id === seller)
    .map((row) => [row.transition_id, row.effective_at, row.observed_at, row.policy_version]);

describe("seller compliance cohort runtime", () => {
  it("resolves the active covering document before precedence ranking", async () => {
    const world = createWorld({
      history: [
        historyRecord({ eventId: "a1", documentId: "doc-a", streamVersion: 1, globalPosition: "1" }),
        historyRecord({
          eventId: "b1",
          documentId: "doc-b",
          streamVersion: 1,
          globalPosition: "2",
          recordedAt: "2025-03-01T00:00:00.000Z",
          effectiveFrom: "2025-03-01T00:00:00.000Z",
          status: "inactive",
        }),
      ],
    });
    world.record("history-active", sale("history-active", "2025-04-01T00:00:00.000Z"));
    expect(await world.runtime.sweep({ now: "2025-05-01T00:00:00.000Z", limit: 10 })).toBe(1);
    expect(world.cohorts.get("history-active")?.state).toBe("member");
  });

  it("fails closed on a proven stream gap and accepts an identical duplicate", async () => {
    const gap = createWorld({
      history: [
        historyRecord({ eventId: "g1", documentId: "doc-gap", streamVersion: 1, globalPosition: "1" }),
        historyRecord({ eventId: "g3", documentId: "doc-gap", streamVersion: 3, globalPosition: "3" }),
      ],
    });
    gap.record("gap", sale("gap", "2025-04-01T00:00:00.000Z"), "2025-05-01T00:00:00.000Z");
    await gap.runtime.sweep({ now: "2025-05-01T00:00:00.000Z", limit: 10 });
    expect(gap.cohorts.has("gap")).toBe(false);
    expect(gap.failures.at(-1)?.[4]).toBe("doc-gap@unknown#3");

    const duplicate = createWorld({
      history: [
        historyRecord({ eventId: "d1", documentId: "doc-dup", streamVersion: 1, globalPosition: "1" }),
        historyRecord({ eventId: "d1", documentId: "doc-dup", streamVersion: 1, globalPosition: "1" }),
      ],
    });
    duplicate.record("dup", sale("dup", "2025-04-01T00:00:00.000Z"), "2025-05-01T00:00:00.000Z");
    expect(await duplicate.runtime.sweep({ now: "2025-05-01T00:00:00.000Z", limit: 10 })).toBe(1);
    expect(duplicate.cohorts.get("dup")?.state).toBe("member");
  });

  it("retains the selected policy identity on a decode failure", async () => {
    const world = createWorld({
      history: [
        historyRecord({
          eventId: "bad1",
          documentId: "doc-bad",
          streamVersion: 1,
          globalPosition: "1",
          value: {},
        }),
      ],
    });
    world.record("bad", sale("bad", "2025-04-01T00:00:00.000Z"), "2025-05-01T00:00:00.000Z");
    await world.runtime.sweep({ now: "2025-05-01T00:00:00.000Z", limit: 10 });
    expect(world.cohorts.has("bad")).toBe(false);
    expect(world.failures.at(-1)?.[4]).toBe("doc-bad@2025-01-01T00:00:00.000Z#1");
  });

  it("admits rowless sellers through the occurrence pass and carries behind-cursor changes forward", async () => {
    const world = createWorld();
    for (const seller of ["s01", "s02", "s03", "s04", "s05"])
      world.record(seller, sale(seller, "2025-05-01T00:00:00.000Z"));
    // Never qualifies, so it stays rowless and sorts first; only a repeated occurrence pass would evaluate it again.
    world.record("s00", sale("s00", "2025-05-01T00:00:00.000Z", "1", "EUR"));
    expect(await sweepTicks(world, [tick(0), tick(5), tick(10), tick(15), tick(20)], 2)).toEqual([
      ["s00", "s01"],
      ["s02", "s03"],
      ["s04", "s05"],
      ["s00"],
      [],
    ]);
    expect([...world.cohorts.keys()].sort()).toEqual(["s01", "s02", "s03", "s04", "s05"]);
    expect([...world.cohorts.values()].every((row) => row.state === "member")).toBe(true);
    expect(world.checkpoints.get("t3-occurrence")).toMatchObject({
      after: "s03",
      policyVersion: world.version(),
      snapshot: "6",
    });
    // Rowless discovery dates each entry at its historical sale and stamps the resolved version.
    expect(ledger(world, "s01")).toEqual([["s01:1:entered", "2025-05-01T00:00:00.000Z", tick(0), world.version()]]);
  });

  it("leaves sellers that already have a cohort row out of the occurrence pass", async () => {
    const world = createWorld({ value: policy, effectiveFrom: "2025-01-01T00:00:00.000Z" });
    world.record("a", sale("a", "2025-05-01T00:00:00.000Z"));
    world.record("b", sale("b", "2025-05-02T00:00:00.000Z"));
    await world.runtime.sweep({ now: tick(0), limit: 10 });
    // An identical-value revision effective May 15; a new rowless seller and a due seller appear.
    world.publish({ documentId: "doc-2", effectiveFrom: "2025-05-15T00:00:00.000Z" });
    world.record("c", sale("c", "2025-05-03T00:00:00.000Z"));
    // Inside this tick's 24-hour change window and outside the next tick's.
    world.record("d", sale("d", "2025-05-19T00:07:00.000Z"), "2025-05-19T00:07:00.000Z");
    const mark = world.evaluations.length;
    await world.runtime.sweep({ now: tick(5), limit: 10 });
    // Every verdict is observed at the injected tick; revision causes remain historically dated.
    expect(world.evaluatedSince(mark).sort()).toEqual(
      [`a@${tick(5)}`, `b@${tick(5)}`, `c@${tick(5)}`, `d@${tick(5)}`].sort(),
    );
    // A new rowless seller joins the next occurrence pass; rows of either version are not re-evaluated by it.
    world.record("e", sale("e", "2025-05-04T00:00:00.000Z"));
    const next = world.evaluations.length;
    await world.runtime.sweep({ now: tick(10), limit: 10 });
    expect(world.evaluatedSince(next)).toEqual([`e@${tick(10)}`]);
  });

  it("discovers a changed seller after a gap longer than the wall-clock window", async () => {
    const world = createWorld();
    world.record("gap-seller", sale("gap-first", "2025-04-01T00:00:00.000Z"));
    await world.runtime.sweep({ now: "2025-04-02T00:00:00.000Z", limit: 10 });
    const mark = world.evaluations.length;
    world.record("gap-seller", sale("gap-second", "2025-04-02T00:00:00.000Z"), "2025-04-02T00:00:00.000Z");
    await world.runtime.sweep({ now: "2025-04-05T12:00:00.000Z", limit: 10 });
    expect(world.evaluatedSince(mark)).toEqual(["gap-seller@2025-04-05T12:00:00.000Z"]);
  });

  it("keeps every cohort row byte-identical under an identical-value revision and completes that pass once", async () => {
    const world = createWorld({ value: pairPolicy });
    world.record("ac8", sale("ac8-a", "2025-05-01T00:00:00.000Z", "250000"));
    world.record("ac8", sale("ac8-b", "2025-05-10T00:00:00.000Z", "250000"));
    await world.runtime.sweep({ now: "2025-05-11T00:00:00.000Z", limit: 10 });
    const before = JSON.stringify([...world.cohorts.values()]);
    const ledgerBefore = JSON.stringify(world.transitions);
    const writes = world.cohortWrites();
    world.publish({ documentId: "doc-2", effectiveFrom: "2025-05-15T00:00:00.000Z" });
    const revisionVersion = world.version();
    const mark = world.evaluations.length;
    await world.runtime.sweep({ now: "2025-05-20T00:00:00.000Z", limit: 10 });
    expect(world.evaluatedSince(mark)).toEqual(["ac8@2025-05-20T00:00:00.000Z"]);
    expect(world.cohortWrites()).toBe(writes);
    expect(JSON.stringify([...world.cohorts.values()])).toBe(before);
    expect(JSON.stringify(world.transitions)).toBe(ledgerBefore);
    expect(world.checkpoints.get("t3-revision")).toMatchObject({ after: null, policyVersion: revisionVersion });
    // The completed pass stays complete on later ticks and after a restart; the unchanged row is not reworked.
    expect(await sweepTicks(world, ["2025-05-20T00:05:00.000Z"], 10)).toEqual([[]]);
    const restarted = { ...world, runtime: world.createRuntime() };
    expect(await sweepTicks(restarted, ["2025-05-20T00:10:00.000Z"], 10)).toEqual([[]]);
    expect(JSON.stringify([...world.cohorts.values()])).toBe(before);
    expect(world.cohortWrites()).toBe(writes);
  });

  it("restores a cohort row removed after a completed sweep from the retained ledger at the same tick", async () => {
    const world = createWorld({ value: pairPolicy });
    world.record("replay", sale("replay-a", "2025-05-01T00:00:00.000Z", "250000"));
    world.record("replay", sale("replay-b", "2025-05-10T00:00:00.000Z", "250000"));
    const now = "2025-05-20T00:00:00.000Z";
    await world.runtime.sweep({ now, limit: 10 });
    const row = JSON.stringify(world.cohorts.get("replay"));
    const ledgerBefore = JSON.stringify(world.transitions);
    world.cohorts.delete("replay");
    await world.runtime.sweep({ now, limit: 10 });
    expect(JSON.stringify(world.cohorts.get("replay") ?? null)).toBe(row);
    expect(JSON.stringify(world.transitions)).toBe(ledgerBefore);
  });

  it("replays the same ordered ticks after cohort-only loss and converges on the original rows and ledger", async () => {
    const world = createWorld();
    world.record("life", sale("life-a", "2025-01-01T00:00:00.000Z"));
    const ticks = ["2025-01-15T00:00:00.000Z", "2025-02-02T00:00:00.000Z", "2025-03-02T00:00:00.000Z"];
    for (const [index, now] of ticks.entries()) {
      await world.runtime.sweep({ now, limit: 10 });
      const expected = world.snapshotState();
      world.cohorts.clear();
      for (const replayed of ticks.slice(0, index + 1)) await world.runtime.sweep({ now: replayed, limit: 10 });
      expect(world.snapshotState()).toEqual(expected);
    }
    expect(ledger(world)).toEqual([
      ["life:1:entered", "2025-01-01T00:00:00.000Z", ticks[0], world.version()],
      ["life:2:exited", "2025-03-01T00:00:00.001Z", ticks[2], world.version()],
    ]);
    expect(world.cohorts.get("life")).toMatchObject({
      state: "outside",
      version: "2",
      exitEffectiveAt: "2025-03-01T00:00:00.001Z",
    });
  });

  it("restores partially lost rows in bounded resumable pages and then does nothing", async () => {
    const world = createWorld();
    for (const seller of ["p1", "p2", "p3"]) world.record(seller, sale(seller, "2025-05-01T00:00:00.000Z"));
    await world.runtime.sweep({ now: tick(0), limit: 10 });
    const expected = JSON.stringify([...world.cohorts.values()]);
    const ledgerBefore = JSON.stringify(world.transitions);
    world.cohorts.delete("p1");
    world.cohorts.delete("p3");
    // Re-running the interrupted tick restores one seller per run and records where the restoration pass stopped.
    expect(await sweepTicks(world, [tick(0)], 1)).toEqual([["p1"]]);
    expect(world.checkpoints.get("recovery")).toMatchObject({ after: "p1" });
    expect(await sweepTicks(world, [tick(0), tick(0)], 1)).toEqual([["p3"], []]);
    expect(world.checkpoints.has("recovery")).toBe(false);
    expect(
      JSON.stringify([...world.cohorts.values()].sort((a, b) => a.sellerAccountId.localeCompare(b.sellerAccountId))),
    ).toBe(expected);
    expect(JSON.stringify(world.transitions)).toBe(ledgerBefore);
  });

  it("dates a late band-only roll-off at the disclosure boundary from reloaded prior evidence", async () => {
    const lifecycle = async (late: string) => {
      const world = createWorld({ value: pairPolicy });
      world.record("band", sale("band-1", "2025-01-01T00:00:00.000Z", "1000000"));
      world.record("band", sale("band-2", "2025-01-10T00:00:00.000Z", "1000000"));
      world.record("band", sale("band-3", "2025-02-01T00:00:00.000Z", "250000"));
      world.record("band", sale("band-4", "2025-02-10T00:00:00.000Z", "250000"));
      await world.runtime.sweep({ now: "2025-01-11T00:00:00.000Z", limit: 10 });
      await world.runtime.sweep({ now: late, limit: 10 });
      return world;
    };
    const entered = [
      ["band:1:entered", "2025-01-10T00:00:00.000Z", "2025-01-11T00:00:00.000Z", "doc-1@2025-01-01T00:00:00.000Z"],
      [
        "band:2:disclosure-band-changed",
        "2025-01-10T00:00:00.000Z",
        "2025-01-11T00:00:00.000Z",
        "doc-1@2025-01-01T00:00:00.000Z",
      ],
    ];
    expect(ledger(await lifecycle("2025-03-01T00:00:00.000Z"))).toEqual(entered);
    for (const late of ["2025-03-01T00:00:00.001Z", "2025-03-12T00:00:00.000Z", "2025-03-20T00:00:00.000Z"]) {
      const world = await lifecycle(late);
      expect(ledger(world)).toEqual([
        ...entered,
        ["band:3:disclosure-band-changed", "2025-03-01T00:00:00.001Z", late, "doc-1@2025-01-01T00:00:00.000Z"],
      ]);
      expect(world.transitions.at(-1)).toMatchObject({ target_state: "member", target_band: "none" });
    }
    // The exit after the band loss is one exited row that clears the band.
    const world = await lifecycle("2025-03-12T00:00:00.000Z");
    await world.runtime.sweep({ now: "2025-04-20T00:00:00.000Z", limit: 10 });
    expect(world.transitions.slice(3)).toEqual([
      expect.objectContaining({
        transition_id: "band:4:exited",
        effective_at: "2025-04-01T00:00:00.001Z",
        target_state: "outside",
        target_band: "none",
      }),
    ]);
  });

  it("re-enters after a revision exit only at the lowering revision instant", async () => {
    for (const disclosureGrossCents of ["2000000", "700000"]) {
      const world = createWorld({ value: pairPolicy, documentId: "doc-1", effectiveFrom: "2025-01-01T00:00:00.000Z" });
      world.record("re", sale("re-1", "2025-05-01T00:00:00.000Z", "250000"));
      world.record("re", sale("re-2", "2025-05-10T00:00:00.000Z", "250000"));
      await world.runtime.sweep({ now: "2025-05-11T00:00:00.000Z", limit: 10 });
      world.publish({
        value: { ...pairPolicy, qualifyingGrossCents: "1000000" },
        documentId: "doc-2",
        effectiveFrom: "2025-05-15T00:00:00.000Z",
      });
      await world.runtime.sweep({ now: "2025-05-16T00:00:00.000Z", limit: 10 });
      // The May 18 sale is recorded late, so the sale-driven trigger reaches the seller first after the lowering revision.
      world.record("re", sale("re-3", "2025-05-18T00:00:00.000Z", "250000"), "2025-05-19T12:00:00.000Z");
      world.publish({
        value: { ...pairPolicy, disclosureGrossCents },
        documentId: "doc-3",
        effectiveFrom: "2025-05-19T00:00:00.000Z",
      });
      await world.runtime.sweep({ now: "2025-05-20T00:00:00.000Z", limit: 10 });
      expect(ledger(world)).toEqual([
        ["re:1:entered", "2025-05-10T00:00:00.000Z", "2025-05-11T00:00:00.000Z", "doc-1@2025-01-01T00:00:00.000Z"],
        ["re:2:exited", "2025-05-15T00:00:00.000Z", "2025-05-16T00:00:00.000Z", "doc-2@2025-05-15T00:00:00.000Z"],
        ["re:3:entered", "2025-05-19T00:00:00.000Z", "2025-05-20T00:00:00.000Z", "doc-3@2025-05-19T00:00:00.000Z"],
        // The earliest qualifying continuous window remains below the
        // disclosure threshold in this fixture; the dedicated pair seam test
        // covers an entered/member-none followed by a band transition.
      ]);
    }
  });

  it("keeps an ordinary roll-off exit when a later revision reaches a late seller first", async () => {
    const reach = async (revision: SellerComplianceCohortPolicyValue, firstTrigger: "t1" | "t2") => {
      const world = createWorld({ value: policy });
      world.record("late", sale("late-1", "2025-01-01T00:00:00.000Z"));
      await world.runtime.sweep({ now: "2025-01-02T00:00:00.000Z", limit: 10 });
      world.publish({ value: revision, documentId: "doc-2", effectiveFrom: "2025-03-10T00:00:00.000Z" });
      if (firstTrigger === "t1")
        world.record("late", sale("late-eur", "2025-03-19T00:00:00.000Z", "1", "EUR"), "2025-03-19T12:00:00.000Z");
      const mark = world.evaluations.length;
      await world.runtime.sweep({ now: "2025-03-20T00:00:00.000Z", limit: 10 });
      expect(world.evaluatedSince(mark)[0]).toBe("late@2025-03-20T00:00:00.000Z");
      return world;
    };
    for (const revision of [policy, { ...policy, qualifyingGrossCents: "2", disclosureGrossCents: "2" }])
      for (const firstTrigger of ["t1", "t2"] as const) {
        const world = await reach(revision, firstTrigger);
        expect(ledger(world).at(-1)).toEqual([
          "late:2:exited",
          "2025-03-01T00:00:00.001Z",
          "2025-03-20T00:00:00.000Z",
          "doc-2@2025-03-10T00:00:00.000Z",
        ]);
        // Re-evaluating the exited seller with unchanged inputs keeps its exit and writes nothing.
        const row = JSON.stringify(world.cohorts.get("late"));
        const writes = world.cohortWrites();
        world.record("late", sale("late-eur-2", "2025-03-21T00:00:00.000Z", "1", "EUR"), "2025-03-21T12:00:00.000Z");
        await world.runtime.sweep({ now: "2025-03-22T00:00:00.000Z", limit: 10 });
        expect(world.cohortWrites()).toBe(writes);
        expect(JSON.stringify(world.cohorts.get("late"))).toBe(row);
      }
  });

  it("exits at the revision instant when the old policy still qualifies, and fails closed without its evidence", async () => {
    const world = createWorld({ value: pairPolicy });
    world.record("raise", sale("raise-1", "2025-04-01T00:00:00.000Z", "250000"));
    world.record("raise", sale("raise-2", "2025-04-15T00:00:00.000Z", "250000"));
    await world.runtime.sweep({ now: "2025-04-16T00:00:00.000Z", limit: 10 });
    world.publish({
      value: { ...pairPolicy, qualifyingGrossCents: "1000000" },
      documentId: "doc-2",
      effectiveFrom: "2025-05-10T00:00:00.000Z",
    });
    // The seller is due on May 1, so the due trigger reaches it before the revision pass.
    const mark = world.evaluations.length;
    await world.runtime.sweep({ now: "2025-05-20T00:00:00.000Z", limit: 10 });
    expect(world.evaluatedSince(mark)[0]).toBe("raise@2025-05-20T00:00:00.000Z");
    expect(ledger(world, "raise").at(-1)).toEqual([
      "raise:2:exited",
      "2025-05-10T00:00:00.000Z",
      "2025-05-20T00:00:00.000Z",
      "doc-2@2025-05-10T00:00:00.000Z",
    ]);

    // A row stamped by a policy whose content was never retained cannot be judged before the revision.
    const blind = createWorld({
      value: { ...pairPolicy, qualifyingGrossCents: "1000000" },
      documentId: "doc-2",
      effectiveFrom: "2025-05-10T00:00:00.000Z",
    });
    blind.record("blind", sale("blind-1", "2025-04-01T00:00:00.000Z", "250000"));
    blind.record("blind", sale("blind-2", "2025-04-15T00:00:00.000Z", "250000"));
    const seeded: CohortRow = {
      sellerAccountId: "blind",
      state: "member",
      band: "none",
      entryEffectiveAt: "2025-04-15T00:00:00.000Z",
      exitEffectiveAt: null,
      windowStart: "2025-04-01T00:00:00.000Z",
      windowEnd: "2025-05-01T00:00:00.000Z",
      qualifyingCount: 2,
      qualifyingGrossCents: "500000",
      unclassifiableCount: 0,
      policyVersion: "unretained@2025-01-01T00:00:00.000Z",
      version: "1",
      nextReevaluationAt: "2025-05-01T00:00:00.000Z",
      updatedAt: "2025-04-16T00:00:00.000Z",
    };
    blind.seed(seeded);
    await blind.runtime.sweep({ now: "2025-05-20T00:00:00.000Z", limit: 10 });
    expect(blind.cohorts.get("blind")).toEqual(seeded);
    expect(blind.transitions).toEqual([]);
    expect(blind.failures).toEqual([
      [
        "blind",
        "2025-05-20T00:00:00.000Z",
        "evaluation",
        expect.stringMatching(/unretained@/),
        "doc-2@2025-05-10T00:00:00.000Z",
      ],
    ]);
  });

  it("keeps the T1 pass open when two short source pages together fill the tick budget", async () => {
    const world = createWorld();
    for (const seller of ["a", "c", "e", "f", "j"])
      world.record(seller, sale(seller, "2025-05-19T12:00:00.000Z"), "2025-05-19T12:00:00.000Z");
    expect(await sweepTicks(world, [tick(0)], 3)).toEqual([["a", "c", "e"]]);
    // Recorded after the pass started: they join this pass's changed-since-checkpoint page.
    for (const seller of ["g", "h"]) world.record(seller, sale(seller, tick(1)), tick(1));
    // Neither source page is full (f, j and g, h), but their union truncates at the budget, so the pass continues.
    expect(await sweepTicks(world, [tick(5), tick(10)], 3)).toEqual([
      ["f", "j"],
      ["g", "h"],
    ]);
  });

  it("continues the occurrence pass under its saved snapshot when an unrelated sale changes the world", async () => {
    const world = createWorld();
    for (const seller of ["s01", "s02", "s03"]) world.record(seller, sale(seller, "2025-05-01T00:00:00.000Z"));
    const perTick: string[][] = [];
    for (const [index, now] of [tick(0), tick(5), tick(10)].entries()) {
      const mark = world.evaluations.length;
      await world.runtime.sweep({ now, limit: 1 });
      perTick.push(world.sellersSince(mark));
      world.record(
        `zz-${index}`,
        sale(`zz-${index}`, "2025-04-01T00:00:00.000Z", "1", "EUR"),
        "2025-04-01T00:00:00.000Z",
      );
    }
    expect(perTick).toEqual([["s01"], ["s02"], ["s03"]]);
  });

  it("pages fail-closed candidates beyond the first limit", async () => {
    const world = createWorld();
    for (const seller of ["r1", "r2", "r3"]) world.record(seller, sale(seller, "2025-05-01T00:00:00.000Z"));
    await world.runtime.sweep({ now: tick(0), limit: 10 });
    const rows = JSON.stringify([...world.cohorts.values()]);
    world.failResolution(new SellerComplianceCohortPolicyDomainError("malformed stored revision"));
    await expect(world.runtime.sweep({ now: tick(5), limit: 2 })).resolves.toBe(2);
    await expect(world.runtime.sweep({ now: tick(10), limit: 2 })).resolves.toBe(1);
    expect(world.failures.map((row) => [row[0], row[2]])).toEqual([
      ["r1", "policy-decode"],
      ["r2", "policy-decode"],
      ["r3", "policy-decode"],
    ]);
    expect(JSON.stringify([...world.cohorts.values()])).toBe(rows);
  });

  it("resumes a T1 pass inside the recording-time window it started with", async () => {
    const world = createWorld();
    for (const seller of ["s01", "s02"])
      world.record(seller, sale(seller, "2025-05-19T00:00:00.000Z"), "2025-05-19T12:00:00.000Z");
    await expect(world.runtime.sweep({ now: "2025-05-20T00:00:00.000Z", limit: 1 })).resolves.toBe(1);
    // 30 hours later a window recomputed from this tick would start after both changes.
    await expect(world.runtime.sweep({ now: "2025-05-21T06:00:00.000Z", limit: 1 })).resolves.toBe(1);
    const t1Pages = world.queries
      .filter((entry) => entry.text.includes("change_sequence > $1::bigint"))
      .map((entry) => entry.values.slice(0, 3));
    expect(t1Pages).toEqual([
      ["0", "2", null],
      ["0", "2", "s01"],
    ]);
    expect(world.sellersSince(0)).toEqual(["s01", "s02"]);
  });

  it("dates a no-new-sale exit by the window that rolled off before the tick's lookback floor", async () => {
    const world = createWorld({ effectiveFrom: "2025-05-15T00:00:00.000Z" });
    world.record("s01", sale("s01", "2025-05-01T00:00:00.000Z"));
    await world.runtime.sweep({ now: "2025-05-20T00:00:00.000Z", limit: 10 });
    // The 2025-05-01 sale is eligible through 2025-07-01, so it lies before this tick's 2025-05-02 floor.
    await expect(world.runtime.evaluateSeller("s01", "2025-07-02T00:00:00.000Z")).resolves.toBe(true);
    expect(world.cohorts.get("s01")).toMatchObject({
      state: "outside",
      band: "none",
      entryEffectiveAt: null,
      exitEffectiveAt: "2025-07-01T00:00:00.001Z",
    });
    expect(ledger(world, "s01").at(-1)).toEqual([
      "s01:2:exited",
      "2025-07-01T00:00:00.001Z",
      "2025-07-02T00:00:00.000Z",
      "doc-1@2025-05-15T00:00:00.000Z",
    ]);
  });
});
