import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSourceObservationMergeCandidateBulkJobRuntime,
  type SourceObservationMergeCandidateBulkJobRuntimeDeps,
} from "./source-observation-merge-candidate-bulk-job-runtime";
import type { CatalogMergeCandidateBulkJobStore } from "./source-observation-runtime-contracts";

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
        status === "active" ? ["merge-candidate-promote"] : ["merge-candidate-promote", "merge-candidate-defer"],
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
