import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogAliasCandidateAttentionRow } from "../../alias-equivalence/read-model/queries";
import type { ProviderScopeMappingAttentionRow } from "../../provider-scope-mapping/read-model/queries";
import type { CatalogScopeRecordAttentionRow } from "../../scope-registry/read-model/queries";
import type { CatalogMergeCandidateAttentionRow } from "../../source-observations/read-model/queries";
import type {
  CatalogIntegrationControlPlaneUnitReadiness,
  SourceObservationIntegrationJob,
} from "../../source-observations/api/runtime";
import type { CatalogIntegrationUnitActivity } from "../../source-observations/api/admin-control-plane-overview";
import { CATALOG_ATTENTION_SUMMARY_WINDOW, type CatalogAttentionQueueWindow } from "../read-model/attention-item";
import {
  assembleCatalogAttentionQueue,
  catalogAttentionQueueWindowSearch,
  parseCatalogAttentionQueueWindow,
  type CatalogAttentionQueueSources,
} from "./contracts";
import { createCatalogAttentionQueueRuntime, type CatalogAttentionControlPlaneSources } from "./runtime";

const GENERATED_AT = "2026-07-09T12:00:00.000Z";

function scopeMappingRow(mappingId: string): ProviderScopeMappingAttentionRow {
  return {
    mapping_id: mappingId,
    scope_record_id: "s1",
    provider_key: "tcgdex",
    unit_key: "u",
    set_id: "sv1",
    set_name: "SV",
    confidence: "candidate",
    review_status: "proposed",
    proposed_at: "2026-07-01T00:00:00.000Z",
  };
}

function mergeRow(overrides: Partial<CatalogMergeCandidateAttentionRow> = {}): CatalogMergeCandidateAttentionRow {
  return {
    candidate_id: "c1",
    scope_record_id: null,
    status: "has-conflicts",
    status_reason: null,
    blocking_conflict_count: 1,
    observation_count: 2,
    created_at: "2026-07-02T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
    stale_at: null,
    ...overrides,
  };
}

function blockedUnit(unitKey: string): CatalogIntegrationControlPlaneUnitReadiness {
  return {
    unitKey,
    providerKey: "tcgdex",
    displayName: `Unit ${unitKey}`,
    productDomain: "pokemon",
    productForm: "sealed",
    ingestionPurpose: null,
    profileVersion: "v1",
    semanticReadiness: "ready",
    credentialReadiness: "blocked",
    credentialReadinessState: "expired",
    credentialRequirement: "required",
    credentialDiagnosticCode: "cred.expired",
    transportReadiness: "ready",
    fixtureValidationStatus: "ready",
    dryRunStatus: "completed",
    observationFacts: 0,
    diagnosticCounts: { info: 0, warning: 0, error: 1 },
    diagnostics: [],
    latestDiagnosticText: null,
    dryRunEvidence: [],
  };
}

function failedJob(
  jobId: string,
  startedAt = "2026-07-08T00:00:00.000Z",
): CatalogIntegrationUnitActivity["recentJobs"][number] {
  return {
    jobId,
    action: "import",
    operatorStatus: "failed",
    phase: "failed",
    completed: 0,
    total: 5,
    unitKey: "u" as CatalogIntegrationUnitActivity["unitKey"],
    providerKey: "tcgdex",
    importScope: "en:pokemon:sv1",
    profileVersion: "v1",
    profileSnapshot: null,
    reapplyProfileMode: null,
    result: null,
    startedAt,
    createdAt: startedAt,
    summary: "failed",
  };
}

function aliasRow(aliasHash: string): CatalogAliasCandidateAttentionRow {
  return {
    alias_hash: aliasHash,
    target_kind: "catalog-item",
    target_id: "i1",
    target_key: "i1",
    alias_text: "Charizard",
    alias_type: "printed-name" as CatalogAliasCandidateAttentionRow["alias_type"],
    confidence: "candidate",
    review_status: "pending",
    provider_key: "tcgdex",
    first_observed_at: "2026-07-06T00:00:00.000Z",
  };
}

function staleScopeRow(scopeRecordId: string): CatalogScopeRecordAttentionRow {
  return {
    scope_record_id: scopeRecordId,
    product_domain: "pokemon",
    scope_kind: "set",
    name: "SV",
    lifecycle_status: "active",
    updated_at: "2026-06-01T00:00:00.000Z",
  };
}

function emptySources(completeness: "complete" | "incomplete" = "complete"): CatalogAttentionQueueSources {
  return {
    proposedScopeMappings: { total: 0, rows: [] },
    mergeCandidates: { conflictTotal: 0, staleTotal: 0, rows: [] },
    unitReadiness: [],
    importJobs: { unitActivity: [], completeness },
    pendingAliasCandidates: { total: 0, rows: [] },
    staleScopeRecords: { total: 0, rows: [] },
  };
}

// One item of every kind so the assembler exercises all six collectors at once.
function sourcesWithOneOfEachKind(): CatalogAttentionQueueSources {
  return {
    proposedScopeMappings: { total: 1, rows: [scopeMappingRow("m1")] },
    mergeCandidates: { conflictTotal: 1, staleTotal: 0, rows: [mergeRow()] },
    unitReadiness: [blockedUnit("u")],
    importJobs: {
      unitActivity: [{ unitKey: "u" as CatalogIntegrationUnitActivity["unitKey"], recentJobs: [failedJob("j1")] }],
      completeness: "complete",
    },
    pendingAliasCandidates: { total: 1, rows: [aliasRow("h1")] },
    staleScopeRecords: { total: 1, rows: [staleScopeRow("s-stale")] },
  };
}

function assemble(
  sources: CatalogAttentionQueueSources,
  options: Readonly<{ parked?: readonly string[]; window?: CatalogAttentionQueueWindow }> = {},
) {
  return assembleCatalogAttentionQueue(sources, {
    generatedAt: GENERATED_AT,
    parkedObservedItemKeys: new Set(options.parked ?? []),
    window: options.window ?? CATALOG_ATTENTION_SUMMARY_WINDOW,
  });
}

describe("assembleCatalogAttentionQueue", () => {
  it("projects one item of every source kind into one severity-ordered queue", () => {
    const queue = assemble(sourcesWithOneOfEachKind());

    expect(queue.empty).toBe(false);
    expect(queue.counts.total).toBe(6);
    expect(queue.countBasis).toEqual({
      total: "exact",
      bySeverity: { critical: "exact", warning: "exact", info: "exact" },
    });
    expect(new Set(queue.items.map((item) => item.kind))).toEqual(
      new Set([
        "unmapped-scope",
        "merge-conflict",
        "provider-health",
        "import-job",
        "alias-candidate",
        "stale-scope-sync",
      ]),
    );
    // Critical (merge-conflict, provider-health, failed job) sort ahead of warning ahead of info.
    expect(queue.items[0]!.severity).toBe("critical");
    expect(queue.items.at(-1)!.severity).toBe("info");
    expect(queue.window).toEqual(CATALOG_ATTENTION_SUMMARY_WINDOW);
  });

  it("counts each source's eligible cohort rather than the returned window", () => {
    const sources: CatalogAttentionQueueSources = {
      ...emptySources(),
      proposedScopeMappings: { total: 5027, rows: [scopeMappingRow("m1")] },
      mergeCandidates: {
        conflictTotal: 300,
        staleTotal: 7,
        rows: [mergeRow({ candidate_id: "c1" })],
      },
      pendingAliasCandidates: { total: 201, rows: [aliasRow("h1")] },
      staleScopeRecords: { total: 1, rows: [staleScopeRow("s1")] },
    };
    const queue = assemble(sources, { window: { kind: null, offset: 0, limit: 1 } });

    expect(queue.items).toHaveLength(4);
    expect(queue.counts.byKind).toEqual({
      "unmapped-scope": 5027,
      "merge-conflict": 307,
      "provider-health": 0,
      "import-job": 0,
      "alias-candidate": 201,
      "stale-scope-sync": 1,
    });
    expect(queue.counts.total).toBe(5027 + 307 + 201 + 1);
    expect(queue.counts.bySeverity).toEqual({ critical: 300, warning: 5027 + 7 + 1, info: 201 });
    expect(queue.coverage["unmapped-scope"]).toEqual({
      total: 5027,
      totalKind: "exact",
      offset: 0,
      limit: 1,
      returned: 1,
      truncated: true,
      nextOffset: 1,
    });
    expect(queue.coverage["stale-scope-sync"]).toMatchObject({ total: 1, truncated: false, nextOffset: null });
  });

  it("counts every observed import job, including jobs past the ten-per-unit display slice", () => {
    const jobs = Array.from({ length: 12 }, (_, index) =>
      failedJob(`j${String(index).padStart(2, "0")}`, `2026-07-08T00:00:${String(index).padStart(2, "0")}.000Z`),
    );
    const sources: CatalogAttentionQueueSources = {
      ...emptySources(),
      importJobs: {
        unitActivity: [{ unitKey: "u" as CatalogIntegrationUnitActivity["unitKey"], recentJobs: jobs }],
        completeness: "complete",
      },
    };

    const summary = assemble(sources);
    expect(summary.counts.byKind["import-job"]).toBe(12);
    expect(summary.coverage["import-job"]).toMatchObject({ totalKind: "exact", returned: 12, truncated: false });

    const paged = assemble(sources, { window: { kind: "import-job", offset: 10, limit: 5 } });
    expect(paged.items.map((item) => item.itemKey)).toEqual(["import-job:j10", "import-job:j11"]);
    expect(paged.coverage["import-job"]).toEqual({
      total: 12,
      totalKind: "exact",
      offset: 10,
      limit: 5,
      returned: 2,
      truncated: false,
      nextOffset: null,
    });
  });

  it("makes the job count, the total and the severities jobs can produce lower bounds for an incomplete snapshot", () => {
    const sources: CatalogAttentionQueueSources = {
      ...sourcesWithOneOfEachKind(),
      importJobs: { ...sourcesWithOneOfEachKind().importJobs, completeness: "incomplete" },
    };
    const queue = assemble(sources);

    expect(queue.coverage["import-job"]).toEqual({
      total: 1,
      totalKind: "lower-bound",
      offset: 0,
      limit: 20,
      returned: 1,
      truncated: true,
      nextOffset: null,
    });
    expect(queue.countBasis).toEqual({
      total: "lower-bound",
      bySeverity: { critical: "lower-bound", warning: "lower-bound", info: "exact" },
    });
    expect(queue.coverage["alias-candidate"].totalKind).toBe("exact");
  });

  it("is empty only for a complete zero; an incomplete zero is unknown work", () => {
    const complete = assemble(emptySources("complete"));
    expect(complete.empty).toBe(true);
    expect(complete.counts.total).toBe(0);
    expect(complete.countBasis.total).toBe("exact");

    const incomplete = assemble(emptySources("incomplete"));
    expect(incomplete.empty).toBe(false);
    expect(incomplete.counts.total).toBe(0);
    expect(incomplete.items).toHaveLength(0);
    expect(incomplete.countBasis.total).toBe("lower-bound");
    expect(incomplete.coverage["import-job"]).toMatchObject({ total: 0, totalKind: "lower-bound", truncated: true });
  });

  it("excludes parked observed items before counting and windowing them", () => {
    const sources: CatalogAttentionQueueSources = {
      ...emptySources(),
      unitReadiness: [blockedUnit("a"), blockedUnit("b"), blockedUnit("c")],
      importJobs: {
        unitActivity: [
          { unitKey: "u" as CatalogIntegrationUnitActivity["unitKey"], recentJobs: [failedJob("j1"), failedJob("j2")] },
        ],
        completeness: "complete",
      },
    };
    const queue = assemble(sources, {
      parked: ["provider-health:tcgdex:a", "import-job:j1"],
      window: { kind: null, offset: 0, limit: 1 },
    });

    expect(queue.counts.byKind["provider-health"]).toBe(2);
    expect(queue.counts.byKind["import-job"]).toBe(1);
    expect(queue.items.map((item) => item.itemKey)).toEqual(["import-job:j2", "provider-health:tcgdex:b"]);
    expect(queue.coverage["provider-health"]).toMatchObject({ total: 2, returned: 1, nextOffset: 1 });
  });

  it("pages one kind and keeps every other kind counted but unreturned", () => {
    const sources: CatalogAttentionQueueSources = {
      ...sourcesWithOneOfEachKind(),
      unitReadiness: [blockedUnit("a"), blockedUnit("b"), blockedUnit("c")],
      // A paged database source reads only its own window; the others arrive with totals and no rows.
      proposedScopeMappings: { total: 40, rows: [] },
      mergeCandidates: { conflictTotal: 3, staleTotal: 2, rows: [] },
      pendingAliasCandidates: { total: 9, rows: [] },
      staleScopeRecords: { total: 4, rows: [] },
    };
    const queue = assemble(sources, { window: { kind: "provider-health", offset: 1, limit: 1 } });

    expect(queue.items.map((item) => item.itemKey)).toEqual(["provider-health:tcgdex:b"]);
    expect(queue.coverage["provider-health"]).toEqual({
      total: 3,
      totalKind: "exact",
      offset: 1,
      limit: 1,
      returned: 1,
      truncated: true,
      nextOffset: 2,
    });
    expect(queue.coverage["unmapped-scope"]).toEqual({
      total: 40,
      totalKind: "exact",
      offset: 0,
      limit: 0,
      returned: 0,
      truncated: true,
      nextOffset: 0,
    });
    expect(queue.coverage["import-job"]).toMatchObject({ total: 1, limit: 0, returned: 0, nextOffset: 0 });
    expect(queue.counts.total).toBe(40 + 5 + 3 + 1 + 9 + 4);
    expect(queue.empty).toBe(false);
  });

  it("returns no items for an offset past the cohort but keeps the count", () => {
    const sources: CatalogAttentionQueueSources = {
      ...emptySources(),
      unitReadiness: [blockedUnit("a"), blockedUnit("b")],
    };
    const queue = assemble(sources, { window: { kind: "provider-health", offset: 500, limit: 200 } });
    expect(queue.items).toEqual([]);
    expect(queue.coverage["provider-health"]).toMatchObject({
      total: 2,
      returned: 0,
      truncated: false,
      nextOffset: null,
    });
    expect(queue.empty).toBe(false);
  });

  it("labels freshness with the generation time and the returned items' observed-at bracket", () => {
    const queue = assemble(sourcesWithOneOfEachKind());
    expect(queue.freshness.generatedAt).toBe(GENERATED_AT);
    expect(queue.freshness.oldestObservedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(queue.freshness.newestObservedAt).toBe(GENERATED_AT);
  });
});

describe("parseCatalogAttentionQueueWindow", () => {
  it("defaults to the twenty-per-kind summary and clamps limit and offset", () => {
    expect(parseCatalogAttentionQueueWindow({})).toEqual({ kind: null, offset: 0, limit: 20 });
    expect(parseCatalogAttentionQueueWindow({ limit: "200", offset: "400" })).toEqual({
      kind: null,
      offset: 400,
      limit: 200,
    });
    expect(parseCatalogAttentionQueueWindow({ limit: "201" })).toMatchObject({ limit: 200 });
    expect(parseCatalogAttentionQueueWindow({ limit: "0" })).toMatchObject({ limit: 1 });
    expect(parseCatalogAttentionQueueWindow({ limit: "abc", offset: "-5" })).toMatchObject({ limit: 20, offset: 0 });
    expect(parseCatalogAttentionQueueWindow({ limit: "12.7", offset: "3.9" })).toMatchObject({ limit: 12, offset: 3 });
  });

  it("accepts a known kind and refuses an unknown one", () => {
    expect(parseCatalogAttentionQueueWindow({ kind: "alias-candidate", offset: "20" })).toEqual({
      kind: "alias-candidate",
      offset: 20,
      limit: 20,
    });
    expect(parseCatalogAttentionQueueWindow({ kind: "everything" })).toBeNull();
    expect(parseCatalogAttentionQueueWindow({ kind: "" })).toMatchObject({ kind: null });
  });

  it("round-trips through the API search, omitting defaults", () => {
    expect(catalogAttentionQueueWindowSearch(CATALOG_ATTENTION_SUMMARY_WINDOW)).toBe("");
    const paged = { kind: "unmapped-scope", offset: 200, limit: 200 } as const;
    const search = catalogAttentionQueueWindowSearch(paged);
    expect(search).toBe("kind=unmapped-scope&offset=200&limit=200");
    const params = new URLSearchParams(search);
    expect(
      parseCatalogAttentionQueueWindow({
        kind: params.get("kind"),
        offset: params.get("offset"),
        limit: params.get("limit"),
      }),
    ).toEqual(paged);
  });
});

const runtimeContext: EventStoreContext = {
  tenantId: "tnt_test" as TenantId,
  audit: { performedByUserId: "usr_reviewer" as UserId, forAccountId: "acc_test" as AccountId },
};

function integrationJob(
  jobId: string,
  operatorStatus: SourceObservationIntegrationJob["operatorStatus"],
): SourceObservationIntegrationJob {
  return {
    jobId,
    syncRunId: null,
    action: "import",
    scope: { provider: "tcgdex", ingestionUnitKey: "u", language: "en", setId: "sv1" },
    profileSnapshot: null,
    reapplyProfileMode: null,
    status: "completed",
    operatorStatus,
    consistency: {
      duplicateSubmissionPolicy: "reuse-active-job",
      profileSnapshotPolicy: "snapshotted-at-enqueue",
      retryResumePolicy: "skip-completed-outcomes",
      partialFailurePolicy: "mixed-outcomes",
      workUnitClaimPolicy: "leased-job-turns",
    },
    progress: { phase: "completed", completed: 0, total: 1, currentName: null, status: "failed" },
    result: null,
    errorMessage: null,
    createdAt: "2026-07-08T00:00:00.000Z",
    startedAt: "2026-07-08T00:00:00.000Z",
    completedAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}

// A database double that answers the queue's four count statements, its window
// statements and the observed-key dismissal lookup. Only proposed mappings hold
// rows (already in queue order), so windows and counts can be checked against them.
function queueDatabase(input: Readonly<{ mappings?: number; parkedKeys?: readonly string[] }> = {}) {
  const mappings = Array.from({ length: input.mappings ?? 0 }, (_, index) =>
    scopeMappingRow(`m${String(index).padStart(5, "0")}`),
  );
  const parked = new Set(input.parkedKeys ?? []);
  const statements: Array<Readonly<{ sql: string; params: readonly unknown[] }>> = [];
  const db: PgQueryable = {
    query: async <T>(sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params });
      const result = (rows: readonly unknown[]) => ({ rows: rows as T[] });
      if (sql.includes("dismissal.item_key = ANY")) {
        return result((params[1] as string[]).filter((key) => parked.has(key)).map((item_key) => ({ item_key })));
      }
      if (sql.includes("conflict_total")) {
        return result([{ conflict_total: 0, stale_total: 0 }]);
      }
      if (sql.includes("AS total")) {
        return result([{ total: sql.includes("catalog_provider_scope_mappings") ? mappings.length : 0 }]);
      }
      if (sql.includes("LIMIT")) {
        if (!sql.includes("catalog_provider_scope_mappings")) {
          return result([]);
        }
        const [, limit, offset] = params as [string, number, number];
        return result(mappings.slice(offset, offset + limit));
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
  return { db, statements };
}

function queueRuntime(
  db: PgQueryable,
  input: Readonly<{
    units?: readonly CatalogIntegrationControlPlaneUnitReadiness[];
    jobs?: readonly SourceObservationIntegrationJob[];
    completeness: "complete" | "incomplete";
  }>,
) {
  const controlPlane = {
    getReadiness: async () => ({
      generatedAt: GENERATED_AT,
      rolloutControls: { generatedAt: GENERATED_AT, controls: [] },
      providerUsage: [],
      units: input.units ?? [],
    }),
    listActiveJobSnapshot: vi.fn(async () => ({ items: input.jobs ?? [], completeness: input.completeness })),
  } satisfies CatalogAttentionControlPlaneSources;
  const deps = { db } as object as CatalogRuntimeDeps;
  return { runtime: createCatalogAttentionQueueRuntime(deps, controlPlane), controlPlane };
}

describe("createCatalogAttentionQueueRuntime", () => {
  it("carries an incomplete job snapshot through as unknown work, never an empty queue", async () => {
    const { runtime, controlPlane } = queueRuntime(queueDatabase().db, { completeness: "incomplete" });
    const queue = await runtime.getCatalogAttentionQueueReadModel({
      context: runtimeContext,
      generatedAt: GENERATED_AT,
    });

    expect(controlPlane.listActiveJobSnapshot).toHaveBeenCalledWith({ context: runtimeContext });
    expect(queue.counts.total).toBe(0);
    expect(queue.empty).toBe(false);
    expect(queue.countBasis.total).toBe("lower-bound");
    expect(queue.coverage["import-job"]).toMatchObject({ total: 0, totalKind: "lower-bound", truncated: true });

    const complete = await queueRuntime(queueDatabase().db, {
      completeness: "complete",
    }).runtime.getCatalogAttentionQueueReadModel({ context: runtimeContext, generatedAt: GENERATED_AT });
    expect(complete.empty).toBe(true);
    expect(complete.countBasis.total).toBe("exact");
  });

  it("counts observed jobs past the display slice and drops parked observed items at one clock", async () => {
    const jobs = Array.from({ length: 12 }, (_, index) =>
      integrationJob(`j${String(index).padStart(2, "0")}`, "failed"),
    );
    const { db, statements } = queueDatabase({ parkedKeys: ["import-job:j03"] });
    const { runtime } = queueRuntime(db, { units: [blockedUnit("u")], jobs, completeness: "complete" });
    const queue = await runtime.getCatalogAttentionQueueReadModel({
      context: runtimeContext,
      generatedAt: GENERATED_AT,
    });

    expect(queue.counts.byKind["import-job"]).toBe(11);
    expect(queue.counts.byKind["provider-health"]).toBe(1);
    expect(queue.coverage["import-job"]).toMatchObject({ totalKind: "exact", returned: 11 });
    expect(queue.items.some((item) => item.itemKey === "import-job:j03")).toBe(false);

    const lookups = statements.filter((statement) => statement.sql.includes("dismissal.item_key = ANY"));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.params[1]).toEqual(
      expect.arrayContaining(["provider-health:tcgdex:u", "import-job:j00", "import-job:j03", "import-job:j11"]),
    );
    // Every source statement and the observed lookup judge parking at the same clock.
    expect(statements.every((statement) => statement.params[0] === GENERATED_AT)).toBe(true);
  });

  it("reads constant, narrow statements per source however large the cohort", async () => {
    const { db, statements } = queueDatabase({ mappings: 5027 });
    const { runtime } = queueRuntime(db, { completeness: "complete" });
    const queue = await runtime.getCatalogAttentionQueueReadModel({
      context: runtimeContext,
      generatedAt: GENERATED_AT,
    });

    expect(queue.counts.byKind["unmapped-scope"]).toBe(5027);
    expect(queue.items).toHaveLength(20);
    expect(queue.coverage["unmapped-scope"]).toMatchObject({ total: 5027, returned: 20, nextOffset: 20 });

    // Four counts plus four windows; no observed items means no dismissal lookup.
    expect(statements).toHaveLength(8);
    const windows = statements.filter((statement) => statement.sql.includes("LIMIT"));
    expect(windows).toHaveLength(4);
    for (const statement of windows) {
      expect(statement.sql).toMatch(/LIMIT \$\d OFFSET \$\d/);
      expect(statement.sql).not.toMatch(/SELECT \*|\.\*|evidence|provenance|membership_json|identity_json/);
      expect(statement.sql).not.toMatch(/c\.conflicts_json\s*,/);
      expect(statement.params.slice(-2)).toEqual([20, 0]);
    }
    expect(statements.every((statement) => statement.sql.includes("catalog_attention_dismissals parked"))).toBe(true);
  });

  it("reads only the paged kind's window and still counts every other kind", async () => {
    const { db, statements } = queueDatabase({ mappings: 401 });
    const { runtime } = queueRuntime(db, { completeness: "complete" });
    const queue = await runtime.getCatalogAttentionQueueReadModel({
      context: runtimeContext,
      generatedAt: GENERATED_AT,
      window: { kind: "unmapped-scope", offset: 200, limit: 200 },
    });

    expect(queue.items.map((item) => item.itemKey)).toEqual(
      Array.from({ length: 200 }, (_, index) => `unmapped-scope:m${String(index + 200).padStart(5, "0")}`),
    );
    expect(queue.coverage["unmapped-scope"]).toMatchObject({
      total: 401,
      offset: 200,
      returned: 200,
      nextOffset: 400,
    });
    const windows = statements.filter((statement) => statement.sql.includes("LIMIT"));
    expect(windows).toHaveLength(1);
    expect(windows[0]!.params).toEqual([GENERATED_AT, 200, 200]);
    expect(statements.filter((statement) => !statement.sql.includes("LIMIT"))).toHaveLength(4);
  });
});
