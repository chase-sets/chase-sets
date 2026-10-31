import { describe, expect, it } from "vitest";
import { writeSellerComplianceCohort } from "./cohort-store";

const evaluation = {
  state: "member" as const,
  band: "none" as const,
  entryEffectiveAt: "2025-01-01T00:00:00.000Z",
  bandEffectiveAt: null,
  exitEffectiveAt: null,
  windowStart: "2025-01-01T00:00:00.000Z",
  windowEnd: "2025-02-01T00:00:00.000Z",
  qualifyingCount: 2,
  qualifyingGrossCents: "500000",
  unclassifiableCount: 0,
  nextReevaluationAt: "2025-02-01T00:00:00.000Z",
};

/** A transaction client over one optional cohort row and one seller's retained ledger. */
function store(row: Record<string, unknown> | null, ledger: readonly Record<string, string>[] = []) {
  const statements: { sql: string; values: readonly unknown[] }[] = [];
  const client = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      statements.push({ sql, values });
      if (sql.startsWith('SELECT seller_account_id AS "sellerAccountId"'))
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      if (sql.includes("ORDER BY transition_version DESC LIMIT 1")) {
        const latest = ledger.at(-1);
        return { rows: latest ? [latest] : [], rowCount: latest ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  return {
    pool: { connect: async () => client } as never,
    writes: () => statements.filter(({ sql }) => /^(INSERT|UPDATE) /.test(sql)),
  };
}
const storedRow = (overrides: Record<string, unknown> = {}) => ({
  sellerAccountId: "seller-1",
  state: "member",
  band: "none",
  version: "4",
  policyVersion: "policy@1",
  entryEffectiveAt: new Date(evaluation.entryEffectiveAt),
  exitEffectiveAt: null,
  windowStart: new Date(evaluation.windowStart),
  windowEnd: new Date(evaluation.windowEnd),
  qualifyingCount: 2,
  qualifyingGrossCents: "500000",
  unclassifiableCount: 0,
  nextReevaluationAt: new Date(evaluation.nextReevaluationAt),
  ...overrides,
});

describe("seller compliance cohort store", () => {
  it("normalizes node-postgres timestamptz values before the unchanged-row guard", async () => {
    const target = store(storedRow());
    await writeSellerComplianceCohort(target.pool, {
      sellerAccountId: "seller-1",
      policyVersion: "policy@1",
      observedAt: "2025-01-05T00:00:00.000Z",
      evaluation,
      expectedVersion: "4",
    });
    expect(target.writes()).toEqual([]);
  });

  it("leaves unchanged evidence byte-identical when only the resolving policy version differs", async () => {
    const target = store(storedRow());
    await writeSellerComplianceCohort(target.pool, {
      sellerAccountId: "seller-1",
      policyVersion: "policy@2",
      observedAt: "2025-01-05T00:00:00.000Z",
      evaluation,
      expectedVersion: "4",
    });
    expect(target.writes()).toEqual([]);
  });

  it("stamps the resolving policy version when the evidence itself changes", async () => {
    const target = store(storedRow());
    await writeSellerComplianceCohort(target.pool, {
      sellerAccountId: "seller-1",
      policyVersion: "policy@2",
      observedAt: "2025-01-05T00:00:00.000Z",
      evaluation: { ...evaluation, nextReevaluationAt: "2025-03-01T00:00:00.001Z" },
      expectedVersion: "4",
    });
    expect(target.writes().map(({ sql, values }) => [sql.split(" ")[0], values[10], values[11]])).toEqual([
      ["UPDATE", "policy@2", "4"],
    ]);
  });

  it("dates a band loss at the evaluation's band instant and never at the observation", async () => {
    const target = store(storedRow({ band: "disclosure" }));
    await writeSellerComplianceCohort(target.pool, {
      sellerAccountId: "seller-1",
      policyVersion: "policy@1",
      observedAt: "2025-03-12T00:00:00.000Z",
      evaluation: { ...evaluation, bandEffectiveAt: "2025-03-01T00:00:00.001Z" },
      expectedVersion: "4",
    });
    const transition = target.writes().find(({ sql }) => sql.includes("cohort_transitions"));
    expect(transition?.values.slice(0, 6)).toEqual([
      "seller-1:5:disclosure-band-changed",
      "seller-1",
      "5",
      "disclosure-band-changed",
      "2025-03-01T00:00:00.001Z",
      "2025-03-12T00:00:00.000Z",
    ]);
    const undated = store(storedRow({ band: "disclosure" }));
    await expect(
      writeSellerComplianceCohort(undated.pool, {
        sellerAccountId: "seller-1",
        policyVersion: "policy@1",
        observedAt: "2025-03-12T00:00:00.000Z",
        evaluation,
        expectedVersion: "4",
      }),
    ).rejects.toThrow(/effective instant/);
    expect(undated.writes().filter(({ sql }) => sql.includes("cohort_transitions"))).toEqual([]);
  });

  it("restores a missing row on the retained ledger's version without reusing a transition id", async () => {
    const ledger = [
      { version: "1", target_state: "member", target_band: "none" },
      { version: "2", target_state: "outside", target_band: "none" },
    ];
    const restored = store(null, ledger);
    const outside = {
      ...evaluation,
      state: "outside" as const,
      entryEffectiveAt: null,
      exitEffectiveAt: "2025-03-01T00:00:00.001Z",
      windowStart: null,
      windowEnd: null,
      qualifyingCount: 0,
      qualifyingGrossCents: "0",
      nextReevaluationAt: null,
    };
    await writeSellerComplianceCohort(restored.pool, {
      sellerAccountId: "seller-1",
      policyVersion: "policy@1",
      observedAt: "2025-03-02T00:00:00.000Z",
      evaluation: outside,
      expectedVersion: "2",
    });
    expect(restored.writes().map(({ sql, values }) => [sql.split(" ")[2], values[1], values[11]])).toEqual([
      ["platform_operations_seller_compliance_cohorts", "outside", "2"],
    ]);
    const reentered = store(null, ledger);
    await writeSellerComplianceCohort(reentered.pool, {
      sellerAccountId: "seller-1",
      policyVersion: "policy@1",
      observedAt: "2025-04-02T00:00:00.000Z",
      evaluation: { ...evaluation, entryEffectiveAt: "2025-04-01T00:00:00.000Z" },
      expectedVersion: "2",
    });
    expect(reentered.writes().map(({ values }) => [values[0], values[11] ?? null])).toEqual([
      ["seller-1", "3"],
      ["seller-1:3:entered", null],
    ]);
  });

  it("writes nothing for an evaluation based on a stale cohort version", async () => {
    for (const [row, ledger, expectedVersion] of [
      [storedRow({ version: "5" }), [], "4"],
      [null, [{ version: "3", target_state: "member", target_band: "none" }], "0"],
    ] as const) {
      const target = store(row, ledger);
      await writeSellerComplianceCohort(target.pool, {
        sellerAccountId: "seller-1",
        policyVersion: "policy@1",
        observedAt: "2025-01-05T00:00:00.000Z",
        evaluation: { ...evaluation, state: "member", nextReevaluationAt: "2025-03-01T00:00:00.001Z" },
        expectedVersion,
      });
      expect(target.writes()).toEqual([]);
    }
  });
});
