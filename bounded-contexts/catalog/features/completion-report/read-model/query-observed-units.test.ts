import { describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { completeManifest } from "../domain/__fixtures__/manifest";
import { parseProductionCatalogCompletionManifest, reconcileProductionCatalogCompletion } from "../domain/index";
import { queryProductionCatalogCompletionFacts } from "./query";

const at = "2026-10-01T00:00:00.000Z";
const unit = { scopeRecordId: "synthetic_scope", providerKey: "synthetic_provider", unitKey: "synthetic_unit" };
const frozen = {
  ...completeManifest(),
  batch: { batchId: "synthetic_batch", planFingerprint: "synthetic_plan", status: "completed" as const },
  providerUnits: [{ ...unit, productionClass: "production" as const, lifecycle: "active" as const, active: true }],
  scopes: [{ scopeRecordId: unit.scopeRecordId, eligible: true, acceptedMappings: [unit] }],
  expectedUnits: [unit],
  providerUsage: [],
};

async function readFacts(state: "failed" | "settled", counts: readonly (number | null)[]) {
  const client = {
    async query(sql: string) {
      if (sql.includes("FROM catalog_scope_sync_batches")) {
        return {
          rows: [
            {
              batch_id: frozen.batch.batchId,
              plan_fingerprint: frozen.batch.planFingerprint,
              status: "completed",
              created_at: at,
            },
          ],
        };
      }
      if (sql.includes("FROM catalog_scope_sync_state")) {
        return {
          rows: [
            {
              scope_record_id: unit.scopeRecordId,
              provider_key: unit.providerKey,
              unit_key: unit.unitKey,
              state,
              last_completed_at: at,
              last_sync_run_id: null,
              observed_count: counts[0],
              changed_count: counts[1],
              failed_count: counts[2],
            },
          ],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  return queryProductionCatalogCompletionFacts({ connect: async () => client } as PgTransactionalPool, {
    batchId: frozen.batch.batchId,
    observedAt: at,
    frozenManifest: frozen,
  });
}

describe("completion facts for observed scope units (synthetic adapter)", () => {
  it.each([
    { counts: [null, null, null], unknown: ["changedCount", "failedCount", "observedCount"] },
    { counts: [5, null, 0], unknown: ["changedCount"] },
    { counts: [0, 0, 0], unknown: [] },
  ])("retains failed coverage with counters $counts", async ({ counts, unknown }) => {
    const facts = await readFacts("failed", counts);
    const manifest = parseProductionCatalogCompletionManifest(facts.manifest);
    expect(manifest.observedUnits).toEqual([
      {
        ...unit,
        state: "failed",
        lastCompletedAt: at,
        syncRunId: null,
        observedCount: counts[0],
        changedCount: counts[1],
        failedCount: counts[2],
      },
    ]);
    expect(facts.unknownFacts).toEqual(
      unknown.map((name) => `observed-unit-counter:synthetic_scope/synthetic_provider/synthetic_unit/${name}`),
    );
    const report = reconcileProductionCatalogCompletion(manifest, { generatedAt: at });
    expect(report.providerUnitStates).toEqual({ failed: 1 });
    expect(report.blockers.map((blocker) => blocker.code)).toContain("failed-job");
    expect(report.blockers.map((blocker) => blocker.code)).not.toContain("never-synced-unit");
    expect(report.result).toBe("incomplete");
  });

  it("still withholds a non-failed unit with any unmeasured counter", async () => {
    const facts = await readFacts("settled", [5, null, 0]);
    expect(parseProductionCatalogCompletionManifest(facts.manifest).observedUnits).toEqual([]);
    expect(facts.unknownFacts).toEqual([
      "observed-unit-counter:synthetic_scope/synthetic_provider/synthetic_unit/changedCount",
    ]);
  });
});
