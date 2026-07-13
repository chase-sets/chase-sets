import { describe, expect, it } from "vitest";
import {
  CATALOG_MERGE_CANDIDATE_EVENT_STREAM_PREFIX,
  catalogScopeMergeCandidatePreservedSurfaces,
  catalogScopeMergeCandidateRebuildChecklist,
  catalogScopeMergeCandidateReleaseVerificationQueries,
  catalogScopeMergeCandidateResetSurfacePolicies,
  catalogScopeMergeCandidateResetTargetTables,
  collectCatalogScopeMergeCandidateVerificationReport,
  evaluateCatalogScopeMergeCandidateResetEvidence,
  resetCatalogMergeCandidateDerivedState,
  type CatalogScopeMergeCandidateVerificationReport,
} from "./catalog-scope-merge-candidate-reset";

describe("catalog scope registry / merge candidate v2 destructive reset plan", () => {
  it("pins reset surface inventory and destructive ordering", () => {
    expect(catalogScopeMergeCandidateResetSurfacePolicies.map((surface) => surface.key)).toEqual([
      "merge-candidate-observation",
      "merge-candidate",
      "provider-scope-mapping-proposal",
      "merge-candidate-event-stream",
    ]);

    const targets = catalogScopeMergeCandidateResetTargetTables();
    expect(targets).toEqual([
      "catalog_merge_candidate_observations",
      "catalog_merge_candidates",
      "catalog_provider_scope_mappings WHERE review_status = 'proposed'",
      `event_store_streams / event_store_events WHERE stream_id LIKE '${CATALOG_MERGE_CANDIDATE_EVENT_STREAM_PREFIX}%'`,
    ]);
    expect(CATALOG_MERGE_CANDIDATE_EVENT_STREAM_PREFIX).toBe("catalog.merge-candidate-");

    expect(targets).not.toContain("catalog_scope_records");
    expect(targets).not.toContain("catalog_source_observations");
    expect(targets.some((target) => target.includes("catalog_items"))).toBe(false);
  });

  it("documents preserved surfaces with a reason for each", () => {
    const targetNames = catalogScopeMergeCandidatePreservedSurfaces.map((surface) => surface.targetName);
    expect(targetNames).toContain("catalog_scope_records");
    expect(targetNames.some((name) => name.includes("catalog_provider_scope_mappings"))).toBe(true);
    expect(targetNames).toContain("catalog_source_observations");
    for (const surface of catalogScopeMergeCandidatePreservedSurfaces) {
      expect(surface.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("collects a verification report for merge-candidate and scope-registry state", async () => {
    const db = new InMemoryCatalogScopeMergeCandidateDb({
      mergeCandidates: 5,
      mergeCandidateObservations: 11,
      eventStreams: 5,
      events: 14,
      providerScopeMappingProposed: 3,
      providerScopeMappingReviewed: 2,
      scopeRecords: 40,
      sourceObservations: 30,
    });

    await expect(collectCatalogScopeMergeCandidateVerificationReport(db)).resolves.toEqual({
      mergeCandidates: 5,
      mergeCandidateObservations: 11,
      mergeCandidateEventStreams: 5,
      mergeCandidateEvents: 14,
      providerScopeMappingProposals: 3,
      preservedScopeRecords: 40,
      preservedReviewedProviderScopeMappings: 2,
      preservedSourceObservations: 30,
    });
  });

  it("wipes merge-candidate derived state while leaving preserved surfaces unchanged", async () => {
    const db = new InMemoryCatalogScopeMergeCandidateDb({
      mergeCandidates: 5,
      mergeCandidateObservations: 11,
      eventStreams: 5,
      events: 14,
      providerScopeMappingProposed: 3,
      providerScopeMappingReviewed: 2,
      scopeRecords: 40,
      sourceObservations: 30,
    });

    const report = await resetCatalogMergeCandidateDerivedState(db);

    expect(report.before).toMatchObject({ mergeCandidates: 5, mergeCandidateObservations: 11 });
    expect(report.after).toEqual({
      mergeCandidates: 0,
      mergeCandidateObservations: 0,
      mergeCandidateEventStreams: 0,
      mergeCandidateEvents: 0,
      providerScopeMappingProposals: 0,
      preservedScopeRecords: 40,
      preservedReviewedProviderScopeMappings: 2,
      preservedSourceObservations: 30,
    });
    expect(report.preservedInvariantsHeld).toBe(true);
    expect(report.steps.map((step) => step.rowsAffected)).toEqual([11, 5, 3, 5]);
  });

  it("throws instead of committing when a preserved surface would change", async () => {
    const db = new InMemoryCatalogScopeMergeCandidateDb({
      mergeCandidates: 2,
      mergeCandidateObservations: 2,
      eventStreams: 2,
      events: 2,
      providerScopeMappingProposed: 1,
      providerScopeMappingReviewed: 1,
      scopeRecords: 10,
      sourceObservations: 10,
    });
    db.corruptPreservedScopeRecordsOnNextDelete = true;

    await expect(resetCatalogMergeCandidateDerivedState(db)).rejects.toThrow("catalog_scope_records row count");
  });

  it("requires staging reset evidence to include approval, backup posture, dry-run, before/after, and rebuild", () => {
    const findings = evaluateCatalogScopeMergeCandidateResetEvidence({
      environment: "staging",
      generatedAt: "",
      operator: "",
      approvalReference: null,
      backupDecision: null,
      targetTables: [],
      dryRun: null,
      before: null,
      after: null,
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      "missing-operator",
      "missing-generated-at",
      "missing-approval-reference",
      "missing-backup-decision",
      "missing-smoke-verification-reference",
      "missing-dry-run",
      "missing-before-verification",
      "missing-after-verification",
      "missing-target-tables",
      "missing-rebuild-evidence",
    ]);
  });

  it("accepts production/prelaunch evidence when the wipe is clean and rebuild is recorded", () => {
    const clean = cleanReport();
    expect(
      evaluateCatalogScopeMergeCandidateResetEvidence({
        environment: "production-prelaunch",
        generatedAt: "2026-07-13T00:00:00.000Z",
        operator: "catalog-release-lead",
        approvalReference: "private-evidence://catalog/scope-merge-candidate-reset/approval-20260713",
        stagingRehearsalReference: "private-evidence://catalog/scope-merge-candidate-reset/staging-rehearsal-20260713",
        smokeVerificationReference: "private-evidence://catalog/scope-merge-candidate-reset/prod-smoke-20260713",
        backupDecision: {
          kind: "skip-backup-accepted-data-loss",
          approver: "catalog-release-lead",
          rationale: "Only unreviewed candidate/proposal state is targeted; source observations are preserved input.",
          targetDataSet: "Catalog Merge Candidate v2 prelaunch state",
        },
        targetTables: catalogScopeMergeCandidateResetTargetTables(),
        dryRun: clean.before,
        before: clean.before,
        after: clean.after,
        rebuild: {
          generatedAt: "2026-07-13T00:05:00.000Z",
          observationsConsidered: clean.before.preservedSourceObservations,
          candidatesCreated: 4,
        },
      }),
    ).toEqual([]);
  });

  it("does not require rebuild evidence for local-dev-test", () => {
    const clean = cleanReport();
    const findings = evaluateCatalogScopeMergeCandidateResetEvidence({
      environment: "local-dev-test",
      generatedAt: "2026-07-13T00:00:00.000Z",
      operator: "catalog-release-lead",
      targetTables: catalogScopeMergeCandidateResetTargetTables(),
      dryRun: clean.before,
      before: clean.before,
      after: clean.after,
    });

    expect(findings).toEqual([]);
  });

  it("flags unsafe targets, preserved-surface drift, and post-reset residue", () => {
    const clean = cleanReport();
    const findings = evaluateCatalogScopeMergeCandidateResetEvidence({
      environment: "production-prelaunch",
      generatedAt: "2026-07-13T00:00:00.000Z",
      operator: "catalog-release-lead",
      approvalReference: "private-evidence://catalog/scope-merge-candidate-reset/approval-20260713",
      stagingRehearsalReference: "private-evidence://catalog/scope-merge-candidate-reset/staging-rehearsal-20260713",
      smokeVerificationReference: "private-evidence://catalog/scope-merge-candidate-reset/prod-smoke-20260713",
      backupDecision: {
        kind: "create-backup-snapshot-export",
        reference: "private-evidence://catalog/scope-merge-candidate-reset/export-20260713",
        owner: "catalog-release-lead",
        retentionUntil: "2026-07-31",
        restoreVerificationReference: "private-evidence://catalog/scope-merge-candidate-reset/restore-check-20260713",
      },
      targetTables: [...catalogScopeMergeCandidateResetTargetTables(), "orders"],
      dryRun: clean.before,
      before: clean.before,
      after: {
        ...clean.after,
        mergeCandidates: 1,
        mergeCandidateObservations: 1,
        providerScopeMappingProposals: 1,
        mergeCandidateEventStreams: 1,
        mergeCandidateEvents: 1,
        preservedScopeRecords: clean.after.preservedScopeRecords - 1,
        preservedReviewedProviderScopeMappings: clean.after.preservedReviewedProviderScopeMappings - 1,
        preservedSourceObservations: clean.after.preservedSourceObservations - 1,
      },
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      "unsafe-target-table",
      "preserved-scope-records-changed",
      "preserved-provider-scope-mappings-changed",
      "preserved-source-observations-changed",
      "post-reset-merge-candidates-remain",
      "post-reset-merge-candidate-observations-remain",
      "post-reset-provider-scope-mapping-proposals-remain",
      "post-reset-event-streams-remain",
      "missing-rebuild-evidence",
    ]);
  });

  it("flags incomplete rebuild observation coverage", () => {
    const clean = cleanReport();
    const findings = evaluateCatalogScopeMergeCandidateResetEvidence({
      environment: "staging",
      generatedAt: "2026-07-13T00:00:00.000Z",
      operator: "catalog-release-lead",
      approvalReference: "private-evidence://catalog/scope-merge-candidate-reset/staging-approval-20260713",
      smokeVerificationReference: "private-evidence://catalog/scope-merge-candidate-reset/staging-smoke-20260713",
      backupDecision: {
        kind: "skip-backup-accepted-data-loss",
        approver: "catalog-release-lead",
        rationale: "Only unreviewed candidate/proposal state is targeted.",
        targetDataSet: "Catalog Merge Candidate v2 prelaunch state",
      },
      targetTables: catalogScopeMergeCandidateResetTargetTables(),
      dryRun: clean.before,
      before: clean.before,
      after: clean.after,
      rebuild: {
        generatedAt: "2026-07-13T00:05:00.000Z",
        observationsConsidered: clean.before.preservedSourceObservations - 5,
        candidatesCreated: 2,
      },
    });

    expect(findings.map((finding) => finding.code)).toEqual(["rebuild-observation-coverage-incomplete"]);
  });

  it("publishes a rebuild checklist naming the deterministic rebuild command", () => {
    const checklist = catalogScopeMergeCandidateRebuildChecklist();
    expect(checklist.some((step) => step.includes("generateCatalogMergeCandidates"))).toBe(true);
    expect(checklist.some((step) => step.includes("Provider Scope Mapping proposal"))).toBe(true);
  });

  it("publishes release verification queries covering every reset target and preserved surface", () => {
    const queries = catalogScopeMergeCandidateReleaseVerificationQueries().join("\n");
    expect(queries).toContain("catalog_merge_candidates");
    expect(queries).toContain("catalog_merge_candidate_observations");
    expect(queries).toContain("catalog.merge-candidate-%");
    expect(queries).toContain("catalog_provider_scope_mappings");
    expect(queries).toContain("catalog_scope_records");
    expect(queries).toContain("catalog_source_observations");
  });
});

type Counts = Readonly<{
  mergeCandidates: number;
  mergeCandidateObservations: number;
  eventStreams: number;
  events: number;
  providerScopeMappingProposed: number;
  providerScopeMappingReviewed: number;
  scopeRecords: number;
  sourceObservations: number;
}>;

function cleanReport(): Readonly<{
  before: CatalogScopeMergeCandidateVerificationReport;
  after: CatalogScopeMergeCandidateVerificationReport;
}> {
  const before: CatalogScopeMergeCandidateVerificationReport = {
    mergeCandidates: 5,
    mergeCandidateObservations: 11,
    mergeCandidateEventStreams: 5,
    mergeCandidateEvents: 14,
    providerScopeMappingProposals: 3,
    preservedScopeRecords: 40,
    preservedReviewedProviderScopeMappings: 2,
    preservedSourceObservations: 30,
  };
  const after: CatalogScopeMergeCandidateVerificationReport = {
    mergeCandidates: 0,
    mergeCandidateObservations: 0,
    mergeCandidateEventStreams: 0,
    mergeCandidateEvents: 0,
    providerScopeMappingProposals: 0,
    preservedScopeRecords: 40,
    preservedReviewedProviderScopeMappings: 2,
    preservedSourceObservations: 30,
  };
  return { before, after };
}

class InMemoryCatalogScopeMergeCandidateDb {
  corruptPreservedScopeRecordsOnNextDelete = false;
  private counts: Counts;

  constructor(counts: Counts) {
    this.counts = { ...counts };
  }

  async connect(): Promise<{ query: InMemoryCatalogScopeMergeCandidateDb["query"]; release: () => void }> {
    return {
      query: this.query.bind(this),
      release: () => undefined,
    };
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<{ rows: T[] }> {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }

    if (sql.startsWith("WITH deleted AS (DELETE FROM ")) {
      return { rows: [{ rows_deleted: this.applyDelete(sql) } as T] };
    }

    return { rows: [{ count: this.countFor(sql, params) } as T] };
  }

  private applyDelete(sql: string): number {
    if (sql.includes("catalog_merge_candidate_observations")) {
      return this.clear("mergeCandidateObservations");
    }
    if (sql.includes("catalog_merge_candidates")) {
      return this.clear("mergeCandidates");
    }
    if (sql.includes("catalog_provider_scope_mappings")) {
      return this.clear("providerScopeMappingProposed");
    }
    if (sql.includes("event_store_streams")) {
      const deleted = this.clear("eventStreams");
      this.counts = { ...this.counts, events: 0 };
      if (this.corruptPreservedScopeRecordsOnNextDelete) {
        this.counts = { ...this.counts, scopeRecords: this.counts.scopeRecords - 1 };
      }
      return deleted;
    }
    throw new Error(`Unexpected delete statement in test fake: ${sql}`);
  }

  private countFor(sql: string, params: readonly unknown[]): number {
    if (sql.includes("event_store_streams")) {
      expectStreamPrefixParam(params);
      return this.counts.eventStreams;
    }
    if (sql.includes("event_store_events")) {
      expectStreamPrefixParam(params);
      return this.counts.events;
    }
    if (sql.includes("catalog_merge_candidate_observations")) {
      return this.counts.mergeCandidateObservations;
    }
    if (sql.includes("catalog_merge_candidates")) {
      return this.counts.mergeCandidates;
    }
    if (sql.includes("catalog_provider_scope_mappings WHERE review_status = 'proposed'")) {
      return this.counts.providerScopeMappingProposed;
    }
    if (sql.includes("catalog_provider_scope_mappings WHERE review_status <> 'proposed'")) {
      return this.counts.providerScopeMappingReviewed;
    }
    if (sql.includes("catalog_scope_records")) {
      return this.counts.scopeRecords;
    }
    if (sql.includes("catalog_source_observations")) {
      return this.counts.sourceObservations;
    }
    throw new Error(`Unexpected count statement in test fake: ${sql}`);
  }

  private clear(key: keyof Counts): number {
    const removed = this.counts[key];
    this.counts = { ...this.counts, [key]: 0 };
    return removed;
  }
}

function expectStreamPrefixParam(params: readonly unknown[]): void {
  if (params[0] !== `${CATALOG_MERGE_CANDIDATE_EVENT_STREAM_PREFIX}%`) {
    throw new Error(`Expected merge-candidate stream prefix parameter, received: ${JSON.stringify(params)}`);
  }
}
