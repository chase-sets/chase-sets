import { describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { CatalogMergeCandidateBulkUnitResult } from "../../source-observations/api/source-observation-runtime-contracts";
import {
  parseProductionCatalogCompletionManifest,
  reconcileProductionCatalogCompletion,
  type ProductionCatalogCompletionManifest,
} from "../domain/index";
import { queryProductionCatalogCompletionFacts } from "./query";

const at = "2026-10-01T00:00:00.000Z";
const frozen: ProductionCatalogCompletionManifest = {
  manifestVersion: "production-catalog-completion-manifest-v1",
  frozenAt: at,
  launchCutoff: at,
  batch: { batchId: "synthetic_batch", planFingerprint: "synthetic_plan", status: "completed" },
  providerUnits: [],
  scopes: [{ scopeRecordId: "synthetic_scope", eligible: true, acceptedMappings: [] }],
  expectedUnits: [],
  observedUnits: [],
  mergeCandidates: [],
  promotions: { create: 0, update: 0, ignore: 0, defer: 0 },
  catalogItems: { draft: 0, published: 0 },
  sourceObservations: { total: 0, observed: 0, changed: 0, promoted: 0, rejected: 0, terminalJobFailures: 0 },
  assetProcessing: { approvedFailures: 0, exclusions: 0 },
  providerUsage: [],
  exclusions: [],
};

function applicationOutcome(
  candidateId: string,
  appliedMode: "create" | "refresh" | "link-existing",
): CatalogMergeCandidateBulkUnitResult {
  return {
    candidateId,
    status: "promoted",
    catalogItemId: null,
    reason: null,
    appliedCatalogItemId: `synthetic_item_${candidateId}`,
    appliedMode,
    approvalVersion: 2,
    planFingerprint: `synthetic_plan_${candidateId}`,
  };
}

// SYNTHETIC read-only adapter controls, not application execution or DB proof.
async function readFacts(input: {
  outcomes?: readonly CatalogMergeCandidateBulkUnitResult[];
  legacy?: boolean;
  candidateCount?: number;
}) {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      let rows: unknown[] = [];
      if (sql.includes("FROM catalog_scope_sync_batches")) {
        rows = [
          { batch_id: "synthetic_batch", plan_fingerprint: "synthetic_plan", status: "completed", created_at: at },
        ];
      } else if (sql.includes("FROM catalog_scope_sync_batch_units")) {
        rows = [];
      } else if (sql.includes("FROM catalog_source_observation_bulk_review_jobs") && !sql.includes("count(*)")) {
        const outcomes = input.outcomes ?? [];
        rows = [
          {
            job_id: "synthetic_job",
            job_kind: input.legacy ? "merge-candidate-promote" : "merge-candidate-promote-application-v1",
            payload: {
              scopeRecordId: "synthetic_scope",
              reason: "Synthetic control",
              ...(input.legacy ? {} : { promotionApplicationVersion: 1 }),
            },
            status: "completed",
            progress: {},
            result: {
              requested: outcomes.length,
              promoted: outcomes.length,
              deferred: 0,
              skippedNotEligible: 0,
              failed: 0,
              outcomes,
            },
            error_message: null,
            created_at: at,
            started_at: at,
            completed_at: at,
            updated_at: at,
          },
        ];
      } else if (sql.includes("FROM catalog_merge_candidates") && sql.includes("GROUP BY status")) {
        rows = [{ status: "promoted", promotion_intent: "create-catalog-item", total: input.candidateCount ?? 1 }];
      } else if (sql.includes("FROM catalog_merge_candidates")) {
        rows = Array.from({ length: input.candidateCount ?? 1 }, (_, index) => ({
          candidate_id: `synthetic_candidate_${index}`,
          scope_record_id: "synthetic_scope",
          status: "promoted",
          conflicts_json: [],
        }));
      } else if (sql.includes("count(*) AS total") && !sql.includes("GROUP BY status")) {
        rows = [{ total: 0 }];
      } else if (!/^(BEGIN|ROLLBACK)/.test(sql) && !sql.includes("FROM catalog_")) {
        throw new Error(`Unexpected synthetic query: ${sql.slice(0, 80)}`);
      }
      return { rows };
    },
    release() {
      statements.push("RELEASE");
    },
  };
  const facts = await queryProductionCatalogCompletionFacts({ connect: async () => client } as PgTransactionalPool, {
    batchId: frozen.batch.batchId,
    observedAt: at,
    frozenManifest: frozen,
  });
  expect([statements[0], ...statements.slice(-2)]).toEqual([
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "ROLLBACK",
    "RELEASE",
  ]);
  expect(() => parseProductionCatalogCompletionManifest(facts.manifest)).not.toThrow();
  return facts;
}

describe("completed candidate application counting (synthetic adapter)", () => {
  it("an approved but unapplied candidate does not count and cannot prove completion", async () => {
    const facts = await readFacts({});
    expect(facts.manifest.promotions).toEqual({ create: 0, update: 0, ignore: 0, defer: 0 });
    expect(facts.unknownFacts).toEqual(["merge-candidate-application:synthetic_candidate_0"]);
  });

  it("counts a completed create application once across recovered outcomes", async () => {
    const applied = applicationOutcome("synthetic_candidate_0", "create");
    const facts = await readFacts({ outcomes: [applied, applied] });
    expect(facts.manifest.promotions).toEqual({ create: 1, update: 0, ignore: 0, defer: 0 });
    expect(facts.unknownFacts).toEqual([]);
    expect(reconcileProductionCatalogCompletion(facts.manifest, { generatedAt: at }).result).toBe("complete");
  });

  it("counts refresh and link-existing as updates even when intent was create", async () => {
    const facts = await readFacts({
      candidateCount: 2,
      outcomes: [
        applicationOutcome("synthetic_candidate_0", "refresh"),
        applicationOutcome("synthetic_candidate_1", "link-existing"),
      ],
    });
    expect(facts.manifest.promotions).toEqual({ create: 0, update: 2, ignore: 0, defer: 0 });
    expect(facts.unknownFacts).toEqual([]);
  });

  it("legacy approval-only results never count as applied", async () => {
    const facts = await readFacts({
      legacy: true,
      outcomes: [{ candidateId: "synthetic_candidate_0", status: "promoted", catalogItemId: null, reason: null }],
    });
    expect(facts.manifest.promotions.create).toBe(0);
    expect(facts.unknownFacts).toEqual(["merge-candidate-application:synthetic_candidate_0"]);
  });

  it("refuses malformed version-1 completion instead of treating it as legacy", async () => {
    await expect(
      readFacts({ outcomes: [{ ...applicationOutcome("synthetic_candidate_0", "create"), appliedMode: null }] }),
    ).rejects.toThrow("malformed");
  });

  it("refuses conflicting recovered applications", async () => {
    await expect(
      readFacts({
        outcomes: [
          applicationOutcome("synthetic_candidate_0", "create"),
          applicationOutcome("synthetic_candidate_0", "refresh"),
        ],
      }),
    ).rejects.toThrow("conflicting applications");
  });
});
