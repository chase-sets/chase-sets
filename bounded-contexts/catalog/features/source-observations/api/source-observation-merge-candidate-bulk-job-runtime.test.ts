import { afterEach, describe, expect, it, vi } from "vitest";
import {
  catalogMergeCandidatePromotionApplicationJobKind,
  CatalogMergeCandidateBulkJobMalformedError,
  createSourceObservationMergeCandidateBulkJobRuntime,
  reconcileCatalogMergeCandidateApplications,
  summarizeCatalogMergeCandidateBulkOutcomes,
  toCatalogMergeCandidateBulkJob,
  type SourceObservationMergeCandidateBulkJobRuntimeDeps,
} from "./source-observation-merge-candidate-bulk-job-runtime";
import type { CatalogMergeCandidateAppliedMode } from "../domain/catalog-merge-candidate";
import type {
  CatalogMergeCandidateBulkJobStore,
  CatalogMergeCandidateBulkUnitResult,
} from "./source-observation-runtime-contracts";

afterEach(() => vi.useRealTimers());

describe("candidate bulk job missing-unit reconciliation", () => {
  it.each([0, 1])(
    "keeps %i retained outcomes queued before grace and fails closed at five minutes",
    async (retained) => {
      vi.useFakeTimers();
      const createdAt = "2026-10-09T00:00:00.000Z";
      vi.setSystemTime(new Date(createdAt).getTime() + 299_999);
      let job: NonNullable<Awaited<ReturnType<CatalogMergeCandidateBulkJobStore["get"]>>> = {
        jobId: "job_synthetic_missing_units",
        claimOwnerId: null,
        claimedUntil: null,
        attemptCount: 0,
        nextEligibleAt: createdAt,
        jobKind: "merge-candidate-promote",
        status: "queued",
        payload: { scopeRecordId: "scope_synthetic", reason: "Synthetic missing-unit test." },
        progress: { phase: "queued", completed: 0, total: 2, currentName: null, status: null },
        result: null,
        errorMessage: null,
        eventContext: null,
        createdAt,
        updatedAt: createdAt,
        startedAt: null,
        completedAt: null,
      };
      const cancel = vi.fn<CatalogMergeCandidateBulkJobStore["cancel"]>(async (input) => {
        job = { ...job, status: "failed", progress: input.progress, errorMessage: input.errorMessage ?? null };
        return job;
      });
      const reconcileTerminalParent = vi.fn();
      const runtime = createSourceObservationMergeCandidateBulkJobRuntime({
        deps: {
          db: {
            query: vi.fn().mockResolvedValue({
              rows: Array.from({ length: retained }, () => ({
                state: "completed",
                result: { candidateId: "cand_synthetic", status: "promoted", catalogItemId: null, reason: null },
              })),
            }),
          },
        },
        jobStore: { listActive: async () => (job.status === "queued" ? [job] : []), get: async () => job, cancel },
        workUnitStore: {
          claimNext: async () => ({ claim: null }),
          summarize: async () => ({ queued: 0, running: 0, expiredClaims: 0 }),
          reconcileTerminalParent,
        },
        mergeCandidates: {},
      } as unknown as SourceObservationMergeCandidateBulkJobRuntimeDeps).services;
      const run = () =>
        runtime.processNextCatalogMergeCandidateBulkJob({ claimOwnerId: "synthetic_worker", claimTtlMs: 60_000 });
      expect(await run()).toBe(0);
      expect(job.status).toBe("queued");
      expect(cancel).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(await run()).toBe(1);
      expect(await runtime.getCatalogMergeCandidateBulkJob(job.jobId)).toMatchObject({
        status: "failed",
        progress: { phase: "failed", completed: retained, total: 2 },
        errorMessage: "Catalog Merge Candidate bulk job is missing enumerated work units.",
      });
      expect(reconcileTerminalParent).not.toHaveBeenCalled();
      expect(await run()).toBe(0);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
});

describe("candidate bulk job filtered readback", () => {
  it.each(["active", "failed"] as const)(
    "bounds %s jobs after kind, scope and operator SQL predicates",
    async (status) => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      const runtime = createSourceObservationMergeCandidateBulkJobRuntime({
        deps: { db: { query } },
      } as unknown as SourceObservationMergeCandidateBulkJobRuntimeDeps).services;
      const context = {
        tenantId: "tnt_synthetic",
        audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
      } as never;
      if (status === "active") {
        await runtime.listActiveCatalogMergeCandidateBulkJobs({
          context,
          scopeRecordId: " scope_synthetic ",
          kind: "merge-candidate-promote",
        });
      } else {
        await runtime.listFailedCatalogMergeCandidateBulkJobs({ context, scopeRecordId: " scope_synthetic " });
      }
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      for (const predicate of [
        "job_kind = ANY",
        "status = ANY",
        "payload->>'scopeRecordId'",
        "event_context->>'tenantId'",
        "event_context->'audit'->>'forAccountId'",
        "event_context->'audit'->>'performedByUserId'",
      ]) {
        expect(sql.indexOf(predicate)).toBeGreaterThan(-1);
        expect(sql.indexOf(predicate)).toBeLessThan(sql.indexOf("ORDER BY"));
      }
      expect(sql).toContain("LIMIT $7");
      expect(params).toEqual([
        status === "active"
          ? ["merge-candidate-promote", "merge-candidate-promote-application-v1"]
          : ["merge-candidate-promote-application-v1", "merge-candidate-promote", "merge-candidate-defer"],
        status === "active" ? ["queued", "running"] : ["failed"],
        "scope_synthetic",
        "tnt_synthetic",
        "acc_synthetic",
        "usr_synthetic",
        50,
      ]);
    },
  );
});

describe("candidate promotion application versioning", () => {
  const createdAt = "2026-10-11T00:00:00.000Z";
  function record(
    jobKind: string,
    payload: Record<string, unknown>,
    outcomes: readonly CatalogMergeCandidateBulkUnitResult[],
  ): Parameters<typeof toCatalogMergeCandidateBulkJob>[0] {
    return {
      jobId: `job_${jobKind}`,
      claimOwnerId: null,
      claimedUntil: null,
      attemptCount: 1,
      nextEligibleAt: createdAt,
      jobKind,
      status: "completed",
      payload: { scopeRecordId: "scope_synthetic", reason: "Synthetic.", ...payload },
      progress: { phase: "completed", completed: outcomes.length, total: outcomes.length, currentName: null, status: null },
      result: summarizeCatalogMergeCandidateBulkOutcomes(outcomes.length, outcomes),
      errorMessage: null,
      eventContext: null,
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt,
      completedAt: createdAt,
    } as Parameters<typeof toCatalogMergeCandidateBulkJob>[0];
  }
  const promoted = (
    candidateId: string,
    appliedCatalogItemId: string,
    appliedMode: CatalogMergeCandidateAppliedMode = "create",
  ) => ({
    candidateId,
    status: "promoted" as const,
    catalogItemId: null,
    reason: null,
    appliedCatalogItemId,
    appliedMode,
    approvalVersion: 2,
    planFingerprint: `sha256:${"b".repeat(64)}`,
  });
  const legacyPromoted = (candidateId: string) => ({
    candidateId,
    status: "promoted" as const,
    catalogItemId: null,
    reason: null,
  });

  it("serializes the version discriminator and keeps retained legacy bytes unchanged", () => {
    const legacy = record("merge-candidate-promote", {}, [legacyPromoted("cand_legacy")]);
    expect(toCatalogMergeCandidateBulkJob(legacy)).toMatchObject({
      kind: "merge-candidate-promote",
      promotionApplicationVersion: null,
      result: legacy.result,
    });
    const applied = record(
      catalogMergeCandidatePromotionApplicationJobKind,
      { promotionApplicationVersion: 1 },
      [promoted("cand_new", "cat_candidate_new")],
    );
    expect(toCatalogMergeCandidateBulkJob(applied)).toMatchObject({
      kind: "merge-candidate-promote",
      promotionApplicationVersion: 1,
      result: { promoted: 1, outcomes: [promoted("cand_new", "cat_candidate_new")] },
    });
    expect(toCatalogMergeCandidateBulkJob(record("merge-candidate-defer", {}, []))).toMatchObject({
      kind: "merge-candidate-defer",
      promotionApplicationVersion: null,
    });
  });

  it.each([
    ["a promoted result without applied facts", [legacyPromoted("cand_malformed")]],
    ["a promoted result with an unknown mode", [{ ...promoted("cand_bad_mode", "cat_x"), appliedMode: "publish" }]],
    [
      "a failed result carrying an applied id",
      [{ ...promoted("cand_failed", "cat_x"), status: "failed" as const, appliedMode: null }],
    ],
  ])("fails closed on version-1 jobs with %s", (_name, outcomes) => {
    expect(() =>
      toCatalogMergeCandidateBulkJob(
        record(
          catalogMergeCandidatePromotionApplicationJobKind,
          { promotionApplicationVersion: 1 },
          outcomes as CatalogMergeCandidateBulkUnitResult[],
        ),
      ),
    ).toThrow(CatalogMergeCandidateBulkJobMalformedError);
  });

  it("fails closed when the stored kind and version discriminator disagree", () => {
    expect(() =>
      toCatalogMergeCandidateBulkJob(record(catalogMergeCandidatePromotionApplicationJobKind, {}, [])),
    ).toThrow(CatalogMergeCandidateBulkJobMalformedError);
    expect(() =>
      toCatalogMergeCandidateBulkJob(record("merge-candidate-promote", { promotionApplicationVersion: 1 }, [])),
    ).toThrow(CatalogMergeCandidateBulkJobMalformedError);
  });

  it("reconciles mixed history by candidate: retries once, approvals never settle, conflicts refuse", () => {
    const jobs = [
      record("merge-candidate-promote", {}, [legacyPromoted("cand_a"), legacyPromoted("cand_legacy_only")]),
      record(catalogMergeCandidatePromotionApplicationJobKind, { promotionApplicationVersion: 1 }, [
        promoted("cand_a", "cat_source_a", "refresh"),
      ]),
      record(catalogMergeCandidatePromotionApplicationJobKind, { promotionApplicationVersion: 1 }, [
        promoted("cand_a", "cat_source_a", "refresh"),
        { ...promoted("cand_b", "x"), status: "skipped-not-eligible", reason: "Already applied.", appliedCatalogItemId: null, appliedMode: null, approvalVersion: null, planFingerprint: null },
      ]),
    ].map(toCatalogMergeCandidateBulkJob);
    const reconciled = reconcileCatalogMergeCandidateApplications(jobs);
    expect([...reconciled.applied]).toEqual([
      [
        "cand_a",
        {
          catalogItemId: "cat_source_a",
          appliedMode: "refresh",
          approvalVersion: 2,
          planFingerprint: `sha256:${"b".repeat(64)}`,
        },
      ],
    ]);
    expect([...reconciled.approvalOnly]).toEqual(["cand_legacy_only"]);

    const conflicting = [
      ...jobs,
      toCatalogMergeCandidateBulkJob(
        record(catalogMergeCandidatePromotionApplicationJobKind, { promotionApplicationVersion: 1 }, [
          promoted("cand_a", "cat_candidate_a", "create"),
        ]),
      ),
    ];
    expect(() => reconcileCatalogMergeCandidateApplications(conflicting)).toThrow("conflicting applications");
  });
});
