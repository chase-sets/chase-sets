import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgQueryFunction, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { GlobalPosition } from "@chase-sets/event-core/storage";
import type { PolicyHistoryReader, PolicyHistoryRecord } from "@chase-sets/platform-policy/policy-history-reader";
import { createCohortEvaluationRuntime } from "./cohort-evaluation-runtime";
import {
  readSellerComplianceCohort,
  readSellerComplianceCohortLedgerHead,
  writeSellerComplianceCohort,
} from "../read-model/cohort-store";
import {
  listCohortChangedSellers,
  readCohortSweepCheckpoint,
  recordCohortEvaluationFailure,
  writeCohortSweepCheckpoint,
  type CohortSweepCheckpoint,
} from "../read-model/cohort-queries";
import {
  listSellerCompletedSalesPage,
  readSellerCompletedSalesSnapshotToken,
  readSellerComplianceSnapshotChangeSequence,
  type SellerSaleFact,
} from "../../seller-compliance-sales/read-model/queries";
import {
  SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  sellerComplianceCohortPolicy,
} from "../domain/seller-compliance-cohort-policy";

vi.mock("../read-model/cohort-store", () => ({
  readSellerComplianceCohort: vi.fn(),
  readSellerComplianceCohortLedgerHead: vi.fn(),
  writeSellerComplianceCohort: vi.fn(),
}));
vi.mock("../read-model/cohort-queries", () => ({
  recordCohortEvaluationFailure: vi.fn(),
  listCohortChangedSellers: vi.fn(),
  readCohortSweepCheckpoint: vi.fn(),
  writeCohortSweepCheckpoint: vi.fn(),
}));
vi.mock("@chase-sets/event-core-postgres", async (original) => ({
  ...(await original<typeof import("@chase-sets/event-core-postgres")>()),
  withPgTransaction: async <T>(db: PgTransactionalPool, operation: (db: PgTransactionalPool) => Promise<T>) =>
    operation(db),
}));
vi.mock("../../seller-compliance-sales/read-model/queries", async (original) => ({
  ...(await original<typeof import("../../seller-compliance-sales/read-model/queries")>()),
  listSellerCompletedSalesPage: vi.fn(),
  readSellerCompletedSalesSnapshotToken: vi.fn(),
  readSellerComplianceSnapshotChangeSequence: vi.fn(),
}));

const tick = "2025-04-20T00:00:00.000Z";
const policy = {
  ...SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE,
  activated: true,
  currencyCode: "USD",
  qualifyingTransactionCount: 1,
  qualifyingGrossCents: "100",
  disclosureGrossCents: "1000",
  windowMonths: 1,
  lookbackMonths: 12,
  comparisonIsInclusive: true,
  saleUnit: "captured-order",
  qualifyingGrossBasis: "item-gross",
  refundTreatment: "exclude-refunded",
  postCaptureCancellationTreatment: "exclude-cancelled",
  mixedLineTreatment: "exclude-mixed",
  unclassifiableTreatment: "exclude-unclassifiable",
  classificationRules: [{ source: "productId", value: "synthetic-card" }],
} as const;
function record(overrides: Partial<PolicyHistoryRecord> = {}): PolicyHistoryRecord {
  return {
    eventId: "synthetic-event-1",
    eventType: "platform-policy.document.created",
    policyKey: sellerComplianceCohortPolicy.policyKey,
    documentId: "synthetic-document",
    streamVersion: 1,
    globalPosition: "2" as GlobalPosition,
    recordedAt: "2025-04-01T00:00:00.000Z",
    effectiveFrom: "2025-01-01T00:00:00.000Z",
    effectiveUntil: null,
    status: "active",
    value: policy,
    ...overrides,
  };
}
function identity(r: PolicyHistoryRecord) {
  return { policyKey: r.policyKey, documentId: r.documentId, eventId: r.eventId, streamVersion: r.streamVersion };
}
function reader(records: readonly PolicyHistoryRecord[], complete = true): PolicyHistoryReader {
  const horizon = "100" as GlobalPosition;
  const continuation = {
    policyKey: sellerComplianceCohortPolicy.policyKey,
    horizon,
    afterGlobalPosition: "0" as GlobalPosition,
  };
  return {
    start: vi.fn(async () => ({ policyKey: continuation.policyKey, horizon, continuation })),
    readPage: vi.fn(async (cursor) => ({
      records,
      horizon,
      complete,
      continuation: { ...cursor, afterGlobalPosition: "100" as GlobalPosition },
    })),
  };
}
const pool = {
  query: vi.fn(() => {
    throw new Error("projection/cache read trap");
  }),
} as unknown as PgTransactionalPool;
async function run(records: readonly PolicyHistoryRecord[], complete = true) {
  return createCohortEvaluationRuntime({ pool, historyReader: reader(records, complete) }).evaluateSeller({
    sellerAccountId: "synthetic-seller",
    tick,
  });
}
const previous = {
  sellerAccountId: "synthetic-seller",
  state: "member",
  band: "none",
  version: "1",
  policyVersion: JSON.stringify(identity(record())),
  entryEffectiveAt: "2025-04-02T00:00:00.000Z",
  exitEffectiveAt: null,
  windowStart: "2025-04-02T00:00:00.000Z",
  windowEnd: "2025-05-02T00:00:00.000Z",
  qualifyingCount: 1,
  qualifyingGrossCents: "100",
  unclassifiableCount: 0,
  nextReevaluationAt: null,
  updatedAt: "2025-04-02T00:00:00.000Z",
} as const;

function sale(occurredAt = "2025-04-02T00:00:00.000Z"): SellerSaleFact {
  return {
    paymentId: "synthetic-payment",
    orderId: "synthetic-order",
    sellerAccountId: "synthetic-seller",
    saleState: "captured",
    occurredAt,
    currencyCode: "USD",
    itemGrossCents: "100",
    shippingChargeCents: "0",
    salesTaxCents: "0",
    authenticityFeeCents: "0",
    protectionCents: "0",
    orderTotalCents: "100",
    marketplaceSalesFeeCents: "0",
    sellerItemNetCents: "100",
    sellerPayoutCents: "100",
    refundedOrderTotalCents: null,
    orderRefundCapCents: null,
    cancelledAt: null,
    captureAnomalies: [],
    refundAnomalies: [],
    reconciliationMismatches: [],
    classificationInputs: [{ productId: "synthetic-card" }],
    classificationInputsVersion: 1,
    changeSequence: "1",
    revision: "1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readSellerComplianceCohort).mockResolvedValue(null);
  vi.mocked(readSellerComplianceCohortLedgerHead).mockResolvedValue(null);
  vi.mocked(readSellerCompletedSalesSnapshotToken).mockResolvedValue({ rowCount: 0, revisionSum: "0" });
  vi.mocked(listSellerCompletedSalesPage).mockResolvedValue({ sales: [], nextCursor: null });
});

describe("cohort-evaluation-runtime", () => {
  it("mounted policy identity: complete-H identity survives selected decode failure byte-for-byte", async () => {
    const selected = record();
    await run([selected]);
    expect(writeSellerComplianceCohort).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        evaluation: expect.objectContaining({ policyIdentity: identity(selected), observedAt: tick }),
        policy: { status: "active", value: policy },
      }),
    );
    vi.mocked(writeSellerComplianceCohort).mockClear();
    await run([{ ...selected, value: { ...policy, activated: "not-a-boolean" } }]);
    expect(writeSellerComplianceCohort).not.toHaveBeenCalled();
    expect(recordCohortEvaluationFailure).toHaveBeenLastCalledWith(
      pool,
      expect.objectContaining({
        sellerAccountId: "synthetic-seller",
        evaluationAt: tick,
        policyVersion: JSON.stringify(identity(selected)),
        failureKind: "policy-decode",
      }),
    );
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("complete-H identity names the failing prior decode record, not the valid selected record", async () => {
    const prior = record();
    const selected = record({
      eventId: "synthetic-event-2",
      eventType: "platform-policy.document.revised",
      streamVersion: 2,
      globalPosition: "9" as GlobalPosition,
      recordedAt: "2025-04-10T00:00:00.000Z",
    });
    await run([prior, selected]);
    expect(writeSellerComplianceCohort).toHaveBeenCalled();
    vi.mocked(writeSellerComplianceCohort).mockClear();
    await run([{ ...prior, value: { ...policy, activated: "not-a-boolean" } }, selected]);
    expect(writeSellerComplianceCohort).not.toHaveBeenCalled();
    expect(recordCohortEvaluationFailure).toHaveBeenLastCalledWith(
      pool,
      expect.objectContaining({
        failureKind: "policy-decode",
        policyVersion: JSON.stringify(identity(prior)),
      }),
    );
  });

  it.each([
    ["stream-gap", () => [record({ streamVersion: 2 })]],
    [
      "eventId identity",
      () => [record(), record({ documentId: "synthetic-other", globalPosition: "3" as GlobalPosition })],
    ],
    [
      "document identity",
      () => [
        record(),
        record({
          eventId: "synthetic-event-2",
          streamVersion: 2,
          globalPosition: "3" as GlobalPosition,
          policyKey: "synthetic.wrong-key",
        }),
      ],
    ],
    [
      "ordered batches",
      () => [
        record(),
        record({ eventId: "synthetic-event-2", streamVersion: 2, globalPosition: "1" as GlobalPosition }),
      ],
    ],
  ] as const)("rejects poison %s without a cohort write", async (_, records) => {
    await run(records());
    expect(writeSellerComplianceCohort).not.toHaveBeenCalled();
    expect(recordCohortEvaluationFailure).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ failureKind: "policy-history", policyVersion: null }),
    );
  });

  it("global holes and identical duplicates are not stream gaps or new authority", async () => {
    const a = record();
    const b = record({
      eventId: "synthetic-event-2",
      eventType: "platform-policy.document.revised",
      streamVersion: 2,
      globalPosition: "91" as GlobalPosition,
    });
    await run([a, a, b]);
    expect(recordCohortEvaluationFailure).not.toHaveBeenCalled();
    expect(writeSellerComplianceCohort).toHaveBeenCalledTimes(1);
  });

  it("same-time final document state is selected as one ordered batch", async () => {
    const prior = record({ value: { ...policy, qualifyingGrossCents: "malformed" } });
    const final = record({
      eventId: "synthetic-batch-final",
      eventType: "platform-policy.document.revised",
      streamVersion: 2,
      globalPosition: "9" as GlobalPosition,
    });
    await run([prior, final]);
    expect(recordCohortEvaluationFailure).not.toHaveBeenCalled();
    expect(writeSellerComplianceCohort).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ evaluation: expect.objectContaining({ policyIdentity: identity(final) }) }),
    );
  });

  it("zero complete history is inert; partial presence never authorizes a write", async () => {
    await run([]);
    expect(writeSellerComplianceCohort).not.toHaveBeenCalled();
    expect(recordCohortEvaluationFailure).not.toHaveBeenCalled();
    await run([record()], false);
    expect(writeSellerComplianceCohort).not.toHaveBeenCalled();
    expect(recordCohortEvaluationFailure).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ failureKind: "policy-history" }),
    );
  });

  it("inactive-first filtering precedes document precedence", async () => {
    const active = record();
    await run([
      active,
      record({
        documentId: "synthetic-inactive",
        eventId: "synthetic-inactive-event",
        globalPosition: "3" as GlobalPosition,
        effectiveFrom: "2025-04-10T00:00:00.000Z",
        status: "inactive",
      }),
    ]);
    expect(writeSellerComplianceCohort).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ evaluation: expect.objectContaining({ policyIdentity: identity(active) }) }),
    );
  });

  it("missing-prior one-failure leaves the cohort untouched and preserves stored bytes", async () => {
    const stored = {
      ...previous,
      policyVersion:
        '{"eventId":"synthetic-missing","streamVersion":1,"documentId":"synthetic-absent","policyKey":"platform-operations.seller-compliance-cohort"}',
    };
    vi.mocked(readSellerComplianceCohort).mockResolvedValue(stored);
    await run([record()]);
    await run([record()]);
    expect(writeSellerComplianceCohort).not.toHaveBeenCalled();
    expect(recordCohortEvaluationFailure).toHaveBeenCalledTimes(2);
    expect(recordCohortEvaluationFailure).toHaveBeenLastCalledWith(
      pool,
      expect.objectContaining({ failureKind: "missing-prior-policy", policyVersion: stored.policyVersion }),
    );
  });

  it("revision-time retains causal effectiveAt while P7 observedAt is the injected tick", async () => {
    vi.mocked(readSellerComplianceCohort).mockResolvedValue(previous);
    vi.mocked(listSellerCompletedSalesPage).mockResolvedValue({ sales: [sale()], nextCursor: null });
    const revised = record({
      eventId: "synthetic-event-2",
      eventType: "platform-policy.document.revised",
      streamVersion: 2,
      globalPosition: "9" as GlobalPosition,
      recordedAt: "2025-04-10T00:00:00.000Z",
      value: { ...policy, qualifyingGrossCents: "500" },
    });
    await run([record(), revised]);
    expect(writeSellerComplianceCohort).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        evaluation: expect.objectContaining({
          state: "outside",
          exitEffectiveAt: "2025-04-10T00:00:00.000Z",
          observedAt: tick,
        }),
      }),
    );
  });

  it("retained boundary loads its preceding lookback before dating a sale expiry", async () => {
    const first = record({
      recordedAt: "2024-04-01T00:00:00.000Z",
      effectiveFrom: "2024-01-01T00:00:00.000Z",
      value: { ...policy, disclosureGrossCents: "100" },
    });
    const revised = record({
      eventId: "synthetic-band-revision",
      eventType: "platform-policy.document.revised",
      streamVersion: 2,
      globalPosition: "9" as GlobalPosition,
      recordedAt: "2025-04-02T00:00:00.000Z",
      effectiveFrom: "2024-01-01T00:00:00.000Z",
    });
    const retained = {
      ...previous,
      version: "2",
      policyVersion: JSON.stringify(identity(revised)),
      entryEffectiveAt: "2024-04-10T00:00:00.000Z",
    };
    vi.mocked(readSellerComplianceCohort).mockResolvedValue(retained);
    vi.mocked(readSellerComplianceCohortLedgerHead).mockResolvedValue({
      ...retained,
      effectiveAt: "2025-04-02T00:00:00.000Z",
      observedAt: "2025-04-02T00:00:00.000Z",
    });
    const fact = sale("2024-04-10T00:00:00.000Z");
    vi.mocked(listSellerCompletedSalesPage).mockImplementation(async (_, input) => ({
      sales: fact.occurredAt >= input.fromInclusive && fact.occurredAt < input.toExclusive ? [fact] : [],
      nextCursor: null,
    }));
    await run([first, revised]);
    expect(recordCohortEvaluationFailure).not.toHaveBeenCalled();
    expect(vi.mocked(writeSellerComplianceCohort).mock.lastCall?.[1].evaluation).toMatchObject({
      state: "outside",
      exitEffectiveAt: "2025-04-10T00:00:00.001Z",
      observedAt: tick,
    });
  });

  it("backdated raise and future control vary only the revision's requested start", async () => {
    vi.mocked(readSellerComplianceCohort).mockResolvedValue(previous);
    vi.mocked(listSellerCompletedSalesPage).mockResolvedValue({ sales: [sale()], nextCursor: null });
    const revised = record({
      eventId: "synthetic-raise",
      eventType: "platform-policy.document.revised",
      streamVersion: 2,
      globalPosition: "9" as GlobalPosition,
      recordedAt: "2025-04-10T00:00:00.000Z",
      value: { ...policy, qualifyingGrossCents: "500" },
    });
    await run([record(), revised]);
    expect(vi.mocked(writeSellerComplianceCohort).mock.lastCall?.[1].evaluation).toMatchObject({
      state: "outside",
      exitEffectiveAt: "2025-04-10T00:00:00.000Z",
    });
    await run([record(), { ...revised, effectiveFrom: "2025-05-01T00:00:00.000Z" }]);
    expect(vi.mocked(writeSellerComplianceCohort).mock.lastCall?.[1].evaluation).toMatchObject({
      state: "member",
      policyIdentity: identity(record()),
    });
  });

  it("late-authority twin never fails or dates an exit before the seller boundary", async () => {
    vi.mocked(readSellerComplianceCohort).mockResolvedValue(previous);
    vi.mocked(listSellerCompletedSalesPage).mockResolvedValue({ sales: [sale()], nextCursor: null });
    const late = record({
      eventId: "synthetic-late",
      eventType: "platform-policy.document.revised",
      streamVersion: 2,
      globalPosition: "9" as GlobalPosition,
      recordedAt: "2025-04-01T12:00:00.000Z",
      value: { ...policy, qualifyingGrossCents: "500" },
    });
    await run([record(), late]);
    expect(recordCohortEvaluationFailure).not.toHaveBeenCalled();
    expect(vi.mocked(writeSellerComplianceCohort).mock.lastCall?.[1].evaluation.exitEffectiveAt).toBe(
      "2025-04-02T00:00:00.001Z",
    );
  });

  it.each(["close without successor", "inactive value", "backdated end"])("inert/null gate binds: %s", async (kind) => {
    vi.mocked(readSellerComplianceCohort).mockResolvedValue(previous);
    const revised = record({
      eventId: "synthetic-inert",
      eventType: "platform-policy.document.revised",
      streamVersion: 2,
      globalPosition: "9" as GlobalPosition,
      recordedAt: "2025-04-10T00:00:00.000Z",
      ...(kind === "close without successor"
        ? { status: "inactive" }
        : kind === "inactive value"
          ? { value: { ...policy, activated: false } }
          : { effectiveUntil: "2025-04-05T00:00:00.000Z" }),
    });
    await run([record(), revised]);
    expect(writeSellerComplianceCohort).not.toHaveBeenCalled();
    expect(recordCohortEvaluationFailure).not.toHaveBeenCalled();
  });

  it("first activation outside history admits nothing; reactivation is dated Apr1 not at an old sale", async () => {
    vi.mocked(listSellerCompletedSalesPage).mockResolvedValue({
      sales: [sale("2023-01-01T00:00:00.000Z")],
      nextCursor: null,
    });
    await run([record()]);
    expect(vi.mocked(writeSellerComplianceCohort).mock.lastCall?.[1].evaluation.state).toBe("outside");
    const first = record({ recordedAt: "2025-01-01T00:00:00.000Z" });
    const inert = record({
      eventId: "synthetic-inert",
      eventType: "platform-policy.document.revised",
      streamVersion: 2,
      globalPosition: "9" as GlobalPosition,
      recordedAt: "2025-03-25T00:00:00.000Z",
      value: { ...policy, activated: false },
    });
    const reactivated = record({
      eventId: "synthetic-reactivated",
      eventType: "platform-policy.document.revised",
      streamVersion: 3,
      globalPosition: "12" as GlobalPosition,
      recordedAt: "2025-04-01T00:00:00.000Z",
    });
    vi.mocked(readSellerComplianceCohort).mockResolvedValue({
      ...previous,
      state: "outside",
      entryEffectiveAt: null,
      exitEffectiveAt: "2025-03-25T00:00:00.000Z",
      policyVersion: JSON.stringify(identity(inert)),
    });
    vi.mocked(listSellerCompletedSalesPage).mockResolvedValue({
      sales: [sale("2025-03-20T00:00:00.000Z")],
      nextCursor: null,
    });
    await run([first, inert, reactivated]);
    expect(vi.mocked(writeSellerComplianceCohort).mock.lastCall?.[1].evaluation).toMatchObject({
      state: "member",
      entryEffectiveAt: "2025-04-01T00:00:00.000Z",
    });
  });

  it("malformed command input fails closed before reading history or projection", async () => {
    const historyReader = reader([record()]);
    const runtime = createCohortEvaluationRuntime({ pool, historyReader });
    await expect(runtime.evaluateSeller({ sellerAccountId: "", tick })).rejects.toThrow();
    await expect(runtime.evaluateSeller({ sellerAccountId: "synthetic-seller", tick: "not-a-date" })).rejects.toThrow();
    expect(historyReader.start).not.toHaveBeenCalled();
  });

  it("normalizes an equivalent tick before excluding future recorded authority", async () => {
    const future = record({
      eventId: "synthetic-future",
      eventType: "platform-policy.document.revised",
      streamVersion: 2,
      globalPosition: "9" as GlobalPosition,
      recordedAt: "2025-04-20T00:00:00.500Z",
    });
    const runtime = createCohortEvaluationRuntime({ pool, historyReader: reader([record(), future]) });
    await runtime.evaluateSeller({ sellerAccountId: "synthetic-seller", tick: "2025-04-20T00:00:00Z" });
    expect(vi.mocked(writeSellerComplianceCohort).mock.lastCall?.[1].evaluation).toMatchObject({
      policyIdentity: identity(record()),
      observedAt: tick,
    });
  });

  it("resume cursor: 100 then 2 after interruption; current snapshot remains frozen", async () => {
    let checkpoint: CohortSweepCheckpoint = {
      version: "0",
      lastCompletedSnapshot: "0",
      currentSnapshot: null,
      rawPageCursor: null,
      sellerCursor: null,
      policyHorizon: "100",
      currentPolicyHorizon: null,
      evaluationAt: null,
      lastEvaluationAt: tick,
    };
    vi.mocked(readCohortSweepCheckpoint).mockImplementation(async () => checkpoint);
    vi.mocked(writeCohortSweepCheckpoint).mockImplementation(async (_, old, next) => {
      checkpoint = { ...next, version: (BigInt(old.version) + 1n).toString() };
      return checkpoint;
    });
    vi.mocked(readSellerComplianceSnapshotChangeSequence).mockResolvedValue("102");
    const sellers = Array.from({ length: 102 }, (_, i) => `synthetic-${String(i).padStart(3, "0")}`);
    vi.mocked(listCohortChangedSellers).mockImplementation(async (_, input) =>
      sellers
        .filter((seller) => input.afterSellerAccountId === null || seller > input.afterSellerAccountId)
        .slice(0, input.limit),
    );
    const runtime = createCohortEvaluationRuntime({ pool, historyReader: reader([record()]) });
    expect(await runtime.runTick({ tick })).toEqual({ processed: 100, failed: 0 });
    expect(checkpoint).toMatchObject({
      currentSnapshot: "102",
      sellerCursor: "synthetic-099",
      rawPageCursor: "synthetic-099",
    });
    vi.mocked(readSellerComplianceSnapshotChangeSequence).mockResolvedValue("103");
    expect(await runtime.runTick({ tick: "2025-04-23T00:00:00.000Z" })).toEqual({ processed: 2, failed: 0 });
    expect(readSellerComplianceSnapshotChangeSequence).toHaveBeenCalledTimes(1);
    expect(checkpoint).toMatchObject({
      currentSnapshot: null,
      lastCompletedSnapshot: "102",
      sellerCursor: "synthetic-101",
      rawPageCursor: "synthetic-101",
    });
    expect(listCohortChangedSellers).toHaveBeenLastCalledWith(
      pool,
      expect.objectContaining({
        currentSnapshot: "102",
        lastCompletedSnapshot: "0",
        afterSellerAccountId: "synthetic-099",
      }),
    );
    expect(writeSellerComplianceCohort).toHaveBeenCalledTimes(102);
  });

  it("snapshot range SQL binds durable sequence bounds, never a 24-hour wall clock", async () => {
    const actual = await vi.importActual<typeof import("../read-model/cohort-queries")>("../read-model/cohort-queries");
    const query = vi.fn<PgQueryFunction>().mockResolvedValue({ rows: [], rowCount: 0 });
    await actual.listCohortChangedSellers(
      { query },
      {
        lastCompletedSnapshot: "11",
        currentSnapshot: "900",
        afterSellerAccountId: "synthetic-cursor",
        evaluationAt: tick,
        policyChanged: false,
        limit: 100,
      },
    );
    expect(query).toHaveBeenCalledWith(expect.any(String), ["11", "900", "synthetic-cursor", tick, false, 100]);
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("change_sequence > $1::bigint");
    expect(sql).toContain("change_sequence <= $2::bigint");
    expect(sql).not.toContain("changed_at");
    expect(sql).toContain("LIMIT $6");
  });
});
