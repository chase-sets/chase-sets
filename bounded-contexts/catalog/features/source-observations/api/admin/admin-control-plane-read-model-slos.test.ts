import { describe, expect, it } from "vitest";
import {
  catalogAdminControlPlaneQueryKeys,
  type CatalogAdminControlPlaneQueryKey,
} from "./admin-control-plane-read-model-contracts";
import {
  assertCatalogAdminControlPlaneSloCoverage,
  catalogAdminControlPlaneFreshnessStates,
  catalogAdminControlPlaneReadModelSlos,
  catalogAdminControlPlaneReadModelSlosByKey,
  getCatalogAdminControlPlaneReadModelSlo,
} from "./admin-control-plane-read-model-slos";

describe("Admin Control Plane read-model SLOs", () => {
  it("covers every #781 query contract exactly once", () => {
    expect(() => assertCatalogAdminControlPlaneSloCoverage()).not.toThrow();
    expect(catalogAdminControlPlaneReadModelSlos.map((slo) => slo.key)).toEqual(catalogAdminControlPlaneQueryKeys);
    expect(Object.keys(catalogAdminControlPlaneReadModelSlosByKey).sort()).toEqual(
      [...catalogAdminControlPlaneQueryKeys].sort(),
    );
  });

  it("sets sane latency budgets and performance checks for every read model", () => {
    for (const slo of catalogAdminControlPlaneReadModelSlos) {
      expect(slo.latency.p95Ms).toBeGreaterThan(0);
      expect(slo.latency.timeoutMs).toBeGreaterThanOrEqual(slo.latency.p95Ms);
      expect(slo.latency.notes.length).toBeGreaterThan(20);
      expect(slo.performanceChecks.length).toBeGreaterThan(0);
      expect(slo.performanceChecks.every((check) => check.representativeRows > 0)).toBe(true);
    }
  });

  it("requires pagination for high-volume diagnostics, jobs, observations, impact, promotion, and audit views", () => {
    const highVolumeKeys: readonly CatalogAdminControlPlaneQueryKey[] = [
      "adapter-transport-diagnostics",
      "fixture-validation-summary",
      "dry-run-evidence-summary",
      "semantic-version-comparison",
      "replay-reapply-impact-summary",
      "import-job-progress-summary",
      "source-observation-review-query",
      "promotion-plan-preview",
      "rollback-retirement-impact-summary",
      "audit-evidence-timeline",
    ];

    for (const key of highVolumeKeys) {
      const slo = getCatalogAdminControlPlaneReadModelSlo(key);
      expect(slo.highVolume).toBe(true);
      expect(slo.pagination.required).toBe(true);
      expect(slo.pagination.mode).not.toBe("none");
      expect(slo.pagination.maxLimit).toBeGreaterThanOrEqual(slo.pagination.defaultLimit ?? 0);
    }
  });

  it("defines UI freshness states for fresh, stale, lagging, partial, and unavailable data", () => {
    const statesUsed = new Set(catalogAdminControlPlaneReadModelSlos.flatMap((slo) => slo.freshness.states));

    expect([...statesUsed].sort()).toEqual([...catalogAdminControlPlaneFreshnessStates].sort());
    for (const slo of catalogAdminControlPlaneReadModelSlos) {
      expect(slo.freshness.freshWithinSeconds).toBeLessThanOrEqual(slo.freshness.staleAfterSeconds);
      expect(slo.freshness.staleAfterSeconds).toBeLessThanOrEqual(slo.freshness.unavailableAfterSeconds);
      expect(slo.freshness.staleStateMessage).toContain("timestamp");
    }
  });

  it("identifies indexes and keyset pagination for high-volume Source Observation review paths", () => {
    const review = getCatalogAdminControlPlaneReadModelSlo("source-observation-review-query");

    expect(review.pagination).toMatchObject({
      mode: "cursor",
      defaultLimit: 100,
      maxLimit: 500,
    });
    expect(review.pagination.cursorFields).toEqual(["observedAt", "observationId"]);
    expect(review.queryShape.existingIndexes).toEqual(
      expect.arrayContaining([
        "catalog_source_observations_provider_idx",
        "catalog_source_observations_status_idx",
        "catalog_source_observations_source_profile_idx",
      ]),
    );
    expect(review.queryShape.plannedIndexes).toContain("catalog_source_observations_admin_review_idx");
    expect(review.performanceChecks.some((check) => check.kind === "explain-plan")).toBe(true);
  });

  it("uses durable job and event indexes for job progress SLOs", () => {
    const jobs = getCatalogAdminControlPlaneReadModelSlo("import-job-progress-summary");

    expect(jobs.pagination.mode).toBe("sse");
    expect(jobs.pagination.cursorFields).toEqual(["jobId", "sequence"]);
    expect(jobs.queryShape.existingIndexes).toEqual(
      expect.arrayContaining([
        "catalog_source_observation_integration_durable_jobs_status_created_idx",
        "catalog_source_observation_integration_durable_jobs_kind_status_idx",
        "catalog_source_observation_integration_job_events_lookup_idx",
        "catalog_source_observation_integration_work_units_job_state_idx",
      ]),
    );
  });

  it("keeps eventual audit timelines tied to projection and event-store query-plan indexes", () => {
    const audit = getCatalogAdminControlPlaneReadModelSlo("audit-evidence-timeline");

    expect(audit.freshness.expectation).toBe("eventual-projection");
    expect(audit.freshness.states).toContain("lagging");
    expect(audit.pagination.mode).toBe("cursor");
    expect(audit.queryShape.existingIndexes).toEqual(
      expect.arrayContaining([
        "event_store_events_context_category_type_global_idx",
        "event_store_events_context_category_global_idx",
      ]),
    );
    expect(audit.queryShape.plannedIndexes).toContain("catalog_admin_audit_evidence_timeline_unit_time_idx");
  });
});
