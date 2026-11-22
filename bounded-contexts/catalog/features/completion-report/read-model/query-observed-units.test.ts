import { describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { completeManifest } from "../domain/__fixtures__/manifest";
import { parseProductionCatalogCompletionManifest, reconcileProductionCatalogCompletion } from "../domain/index";
import { assertSupportSafe } from "../domain/redaction";
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

async function readFacts(
  state: "failed" | "settled",
  counts: readonly (number | null)[],
  failedImports: readonly object[] = [],
) {
  let inSnapshot = false;
  const client = {
    async query(sql: string, params?: readonly unknown[]) {
      if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") {
        inSnapshot = true;
        return { rows: [] };
      }
      expect(inSnapshot).toBe(true);
      if (sql === "ROLLBACK") inSnapshot = false;
      if (sql.includes("AS outcome_status")) {
        expect(params).toEqual([frozen.batch.batchId]);
        return { rows: failedImports };
      }
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
    release() {
      expect(inSnapshot).toBe(false);
    },
  };
  return queryProductionCatalogCompletionFacts({ connect: async () => client } as PgTransactionalPool, {
    batchId: frozen.batch.batchId,
    observedAt: at,
    frozenManifest: frozen,
  });
}

describe("completion facts for observed scope units (synthetic adapter)", () => {
  it("reports batch-linked import failures without including provider values", async () => {
    const link = {
      scope_record_id: "synthetic_scope",
      sync_run_id: "synthetic_run",
      provider_key: "scrydex",
      unit_key: "scrydex:lorcana:single-card:source-observation-import",
    };
    const providerText = "SYNTHETIC_CARD_TEXT https://provider.invalid/card Bearer SYNTHETIC_CREDENTIAL";
    const facts = await readFacts(
      "failed",
      [0, 0, 1],
      [
        {
          ...link,
          integration_job_id: "synthetic_job_mapping",
          outcome_status: "failed",
          reason: `Catalog provider 'scrydex' source observation normalization failed at normalizedObservation.fields.cardNumber: ${providerText}`,
        },
        {
          ...link,
          integration_job_id: "synthetic_job_unclassified",
          outcome_status: "failed",
          reason: `Unexpected provider value: ${providerText}`,
        },
      ],
    );
    const expectedLink = {
      scopeRecordId: link.scope_record_id,
      syncRunId: link.sync_run_id,
      providerKey: link.provider_key,
      unitKey: link.unit_key,
      outcomeStatus: "failed",
    };
    expect(facts.reportedFacts.failedImportUnits).toEqual([
      {
        ...expectedLink,
        integrationJobId: "synthetic_job_mapping",
        reason: {
          code: "source-observation-normalization-failed",
          fieldPath: "normalizedObservation.fields.cardNumber",
        },
      },
      {
        ...expectedLink,
        integrationJobId: "synthetic_job_unclassified",
        reason: { code: "provider-import-failed", fieldPath: null },
      },
    ]);
    expect(JSON.stringify(facts)).not.toMatch(/SYNTHETIC_CARD_TEXT|provider\.invalid|SYNTHETIC_CREDENTIAL/);
    expect(() => assertSupportSafe(facts.reportedFacts)).not.toThrow();
  });

  it.each([
    { counts: [null, null, null], unknown: ["changedCount", "failedCount", "observedCount"] },
    { counts: [5, null, 0], unknown: ["changedCount"] },
    { counts: [0, 0, 0], unknown: [] },
  ])("retains failed coverage with counters $counts", async ({ counts, unknown }) => {
    const facts = await readFacts("failed", counts);
    expect(facts.reportedFacts).not.toHaveProperty("failedImportUnits");
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
