import { describe, expect, it, vi } from "vitest";
import type { PgQueryFunction, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { parseIsoUtcTimestamp as iso } from "@chase-sets/primitives/iso-utc-timestamp";
import type { CohortEvaluation } from "../domain/cohort-window";
import { SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE } from "../domain/seller-compliance-cohort-policy";
import {
  readSellerComplianceCohort,
  readSellerComplianceCohortLedgerHead,
  writeSellerComplianceCohort,
  type CohortWrite,
} from "./cohort-store";

const observedAt = iso("2025-05-13T00:00:00.000Z");
const entryAt = iso("2025-05-10T00:00:00.000Z");
const bandAt = iso("2025-05-12T00:00:00.000Z");
const evaluation: CohortEvaluation = {
  effectiveAt: bandAt,
  observedAt,
  policyIdentity: {
    policyKey: "platform-operations.seller-compliance-cohort",
    documentId: "synthetic-policy",
    eventId: "synthetic-revision",
    streamVersion: 1,
  },
  state: "member",
  band: "disclosure",
  entryEffectiveAt: entryAt,
  bandEffectiveAt: bandAt,
  exitEffectiveAt: null,
  windowStart: entryAt,
  windowEnd: iso("2025-06-10T00:00:00.000Z"),
  qualifyingCount: 2,
  qualifyingGrossCents: "2000000",
  unclassifiableCount: 0,
  nextReevaluationAt: iso("2025-06-10T00:00:00.001Z"),
};
const input: CohortWrite = {
  sellerAccountId: "synthetic-seller",
  expectedVersion: "0",
  evaluation,
  policy: { status: "active", value: { ...SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE, activated: true } },
};
const row = (overrides: Record<string, unknown> = {}) => ({
  sellerAccountId: input.sellerAccountId,
  state: evaluation.state,
  band: evaluation.band,
  version: "2",
  policyVersion: JSON.stringify(evaluation.policyIdentity),
  entryEffectiveAt: new Date(entryAt),
  exitEffectiveAt: null,
  windowStart: new Date(entryAt),
  windowEnd: new Date(evaluation.windowEnd!),
  qualifyingCount: 2,
  qualifyingGrossCents: "2000000",
  unclassifiableCount: 0,
  nextReevaluationAt: new Date(evaluation.nextReevaluationAt!),
  updatedAt: new Date(observedAt),
  ...overrides,
});
function store(current: Record<string, unknown> | null = null, ledger: Record<string, unknown>[] = []) {
  const query = vi.fn<PgQueryFunction>().mockResolvedValue({ rows: [], rowCount: 1 });
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
  query.mockResolvedValueOnce({ rows: current ? [current] : [], rowCount: current ? 1 : 0 });
  query.mockResolvedValueOnce({ rows: ledger, rowCount: ledger.length });
  const client = { query, release: vi.fn() };
  const pool: PgTransactionalPool = { query, connect: async () => client };
  return { pool, query, writes: () => query.mock.calls.filter(([sql]) => /^(INSERT|UPDATE) /.test(sql)) };
}
function ledgerRow(version = "2", overrides: Record<string, unknown> = {}) {
  return {
    version,
    kind: "disclosure-band-changed",
    effective_at: new Date(bandAt),
    observed_at: new Date(observedAt),
    policy_version: JSON.stringify(evaluation.policyIdentity),
    target_state: "member",
    target_band: "disclosure",
    ...overrides,
  };
}

describe("seller compliance cohort store", () => {
  it("pair: dates entry and disclosure separately and gives each transition its own target", async () => {
    const target = store();
    await writeSellerComplianceCohort(target.pool, input);
    expect(target.writes().map(([, values]) => values)).toEqual([
      expect.arrayContaining([input.sellerAccountId, "member", "disclosure", "2", observedAt]),
      [
        "synthetic-seller:1:entered",
        input.sellerAccountId,
        "1",
        "entered",
        entryAt,
        observedAt,
        JSON.stringify(evaluation.policyIdentity),
        "member",
        "none",
      ],
      [
        "synthetic-seller:2:disclosure-band-changed",
        input.sellerAccountId,
        "2",
        "disclosure-band-changed",
        bandAt,
        observedAt,
        JSON.stringify(evaluation.policyIdentity),
        "member",
        "disclosure",
      ],
    ]);
    expect(target.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("pair: permits equal dates only for simultaneous entry and disclosure", async () => {
    const target = store();
    await writeSellerComplianceCohort(target.pool, {
      ...input,
      evaluation: { ...evaluation, bandEffectiveAt: entryAt, effectiveAt: entryAt },
    });
    expect(
      target
        .writes()
        .slice(1)
        .map(([, values]) => values?.[4]),
    ).toEqual([entryAt, entryAt]);
  });

  it("guard: freezes inactive value, inactive status and absent coverage without opening a transaction", async () => {
    for (const policy of [
      null,
      { ...input.policy!, status: "inactive" as const },
      { ...input.policy!, value: SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE },
    ]) {
      const target = store(row());
      await writeSellerComplianceCohort(target.pool, { ...input, policy });
      expect(target.query).not.toHaveBeenCalled();
    }
    const target = store();
    await writeSellerComplianceCohort(target.pool, { ...input, evaluation: { ...evaluation, policyIdentity: null } });
    expect(target.query).not.toHaveBeenCalled();
  });

  it("guard: normalizes pg Dates and preserves steady/day-after evidence despite newer policy identity", async () => {
    for (const day of [observedAt, iso("2025-05-14T00:00:00.000Z")]) {
      const target = store(row());
      await writeSellerComplianceCohort(target.pool, {
        ...input,
        expectedVersion: "2",
        evaluation: {
          ...evaluation,
          observedAt: day,
          policyIdentity: { ...evaluation.policyIdentity!, streamVersion: 2 },
        },
      });
      expect(target.writes()).toEqual([]);
    }
  });

  it("guard: early work advances the due instant without inventing a transition", async () => {
    const target = store(row());
    const next = iso("2025-06-12T00:00:00.001Z");
    await writeSellerComplianceCohort(target.pool, {
      ...input,
      expectedVersion: "2",
      evaluation: { ...evaluation, nextReevaluationAt: next },
    });
    expect(target.writes()).toHaveLength(1);
    expect(target.writes()[0]?.[1]?.[12]).toBe(next);
    expect(target.writes()[0]?.[1]?.[11]).toBe("2");
  });

  it("pair: delayed observations change observation stamps, never causal transition instants", async () => {
    const early = store();
    const delayed = store();
    await writeSellerComplianceCohort(early.pool, input);
    await writeSellerComplianceCohort(delayed.pool, {
      ...input,
      evaluation: { ...evaluation, observedAt: iso("2025-05-20T00:00:00.000Z") },
    });
    const payloads = (target: ReturnType<typeof store>) =>
      target
        .writes()
        .slice(1)
        .map(([, values]) => values?.filter((_, index) => index !== 5));
    expect(payloads(delayed)).toEqual(payloads(early));
    expect(delayed.writes()[1]?.[1]?.[5]).toBe("2025-05-20T00:00:00.000Z");
  });

  it("guard: rejects stale row and retained-ledger versions, including numeric versions above nine", async () => {
    for (const target of [store(row({ version: "10" })), store(null, [ledgerRow("10")])]) {
      await writeSellerComplianceCohort(target.pool, { ...input, expectedVersion: "9" });
      expect(target.writes()).toEqual([]);
    }
  });

  it("guard: uses the read version in SQL and writes no transition when the guarded update loses", async () => {
    const target = store(row({ band: "none", version: "9" }));
    target.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await writeSellerComplianceCohort(target.pool, { ...input, expectedVersion: "9" });
    expect(target.writes()).toHaveLength(1);
    expect(target.writes()[0]?.[0]).toContain("WHERE seller_account_id=$1 AND version=$15 AND updated_at <= $14");
    expect(target.writes()[0]?.[1]?.at(-1)).toBe("9");
  });

  it("guard: discards an older observation even if the transition version has not moved", async () => {
    const target = store(row({ updatedAt: new Date("2025-05-14T00:00:00.000Z") }));
    await writeSellerComplianceCohort(target.pool, {
      ...input,
      expectedVersion: "2",
      evaluation: { ...evaluation, qualifyingCount: 3 },
    });
    expect(target.writes()).toEqual([]);
  });

  it("seam: unchanged retries never update ledger payloads or published_at", async () => {
    const target = store(row(), [ledgerRow()]);
    await writeSellerComplianceCohort(target.pool, { ...input, expectedVersion: "2" });
    expect(target.writes()).toEqual([]);
    const initial = store();
    await writeSellerComplianceCohort(initial.pool, input);
    for (const [sql] of initial.writes().slice(1)) {
      expect(sql).toContain("published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)");
      expect(sql).not.toContain("ON CONFLICT");
    }
  });

  it("seam: missing, reversed, future or backdated transition instants fail before any write", async () => {
    for (const change of [
      { entryEffectiveAt: null },
      { bandEffectiveAt: null },
      { bandEffectiveAt: iso("2025-05-09T00:00:00.000Z") },
      { bandEffectiveAt: iso("2025-05-14T00:00:00.000Z") },
    ]) {
      const target = store();
      await expect(
        writeSellerComplianceCohort(target.pool, { ...input, evaluation: { ...evaluation, ...change } }),
      ).rejects.toThrow(/instant|observation/);
      expect(target.writes()).toEqual([]);
      expect(target.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    }
    const target = store(null, [ledgerRow("10", { kind: "exited", target_state: "outside", target_band: "none" })]);
    await expect(writeSellerComplianceCohort(target.pool, { ...input, expectedVersion: "10" })).rejects.toThrow(
      /retained ledger/,
    );
    expect(target.writes()).toEqual([]);
  });

  it("seam: exit alone targets outside/none and restores continue numeric ledger ids", async () => {
    const target = store(row());
    const exitAt = iso("2025-06-10T00:00:00.001Z");
    await writeSellerComplianceCohort(target.pool, {
      ...input,
      expectedVersion: "2",
      evaluation: {
        ...evaluation,
        state: "outside",
        band: "none",
        entryEffectiveAt: null,
        bandEffectiveAt: null,
        exitEffectiveAt: exitAt,
        effectiveAt: exitAt,
        observedAt: iso("2025-06-12T00:00:00.000Z"),
      },
    });
    expect(
      target
        .writes()
        .slice(1)
        .map(([, values]) => [values?.[0], values?.[7], values?.[8]]),
    ).toEqual([["synthetic-seller:3:exited", "outside", "none"]]);
    const restored = store(null, [
      ledgerRow("9", {
        effective_at: new Date("2025-05-01T00:00:00.000Z"),
        kind: "exited",
        target_state: "outside",
        target_band: "none",
      }),
    ]);
    await writeSellerComplianceCohort(restored.pool, { ...input, expectedVersion: "9" });
    expect(
      restored
        .writes()
        .slice(1)
        .map(([, values]) => values?.[0]),
    ).toEqual(["synthetic-seller:10:entered", "synthetic-seller:11:disclosure-band-changed"]);
  });

  it("normalizes reads and chooses a numeric ledger head, never lexicographic version order", async () => {
    const query = vi
      .fn<PgQueryFunction>()
      .mockResolvedValueOnce({ rows: [row()] })
      .mockResolvedValueOnce({ rows: [ledgerRow("9"), ledgerRow("10", { kind: "entered", target_band: "none" })] });
    const cohort = await readSellerComplianceCohort({ query }, input.sellerAccountId);
    expect(cohort?.entryEffectiveAt).toBe(entryAt);
    expect(cohort?.updatedAt).toBe(observedAt);
    expect(await readSellerComplianceCohortLedgerHead({ query }, input.sellerAccountId)).toMatchObject({
      version: "10",
      state: "member",
      band: "none",
    });
    expect(query.mock.calls[1]?.[0]).toContain("ORDER BY kind, transition_version DESC");
  });
});
