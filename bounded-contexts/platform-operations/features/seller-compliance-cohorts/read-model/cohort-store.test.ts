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

it("normalizes node-postgres timestamptz values before the unchanged-row guard", async () => {
  const queries: string[] = [];
  const row = {
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
  };
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith("SELECT")) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client };
  await writeSellerComplianceCohort(pool as never, {
    sellerAccountId: "seller-1",
    policyVersion: "policy@1",
    observedAt: "2025-01-05T00:00:00.000Z",
    evaluation,
  });
  expect(queries.some((sql) => sql.startsWith("UPDATE platform_operations_seller_compliance_cohorts"))).toBe(false);
});
