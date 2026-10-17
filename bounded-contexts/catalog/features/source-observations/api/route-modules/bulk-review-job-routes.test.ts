import { describe, expect, it, vi } from "vitest";
import type { SourceObservationRouteServices } from "../route";
import type { CatalogMergeCandidateBulkJob, CatalogMergeCandidateBulkJobPage } from "../runtime";
import {
  catalogMergeCandidatePromotionApplicationJobKind,
  CatalogMergeCandidateBulkJobCursorError,
  CatalogMergeCandidateBulkJobMalformedError,
  createSourceObservationMergeCandidateBulkJobRuntime,
  type SourceObservationMergeCandidateBulkJobRuntimeDeps,
} from "../source-observation-merge-candidate-bulk-job-runtime";
import { buildApp, context, viewOnlyActor } from "./route-test-harness";

describe("bulk review job routes — Catalog Merge Candidate scope jobs", () => {
  it("serializes version-1 application facts and classified diagnostics exactly as recorded", async () => {
    const legacy = candidateJob("job_legacy", { status: "completed" });
    const job: CatalogMergeCandidateBulkJob = {
      ...legacy,
      jobId: "job_applied",
      promotionApplicationVersion: 1,
      result: {
        requested: 2,
        promoted: 1,
        deferred: 0,
        skippedNotEligible: 0,
        failed: 1,
        outcomes: [
          {
            candidateId: "cand_applied",
            status: "promoted",
            catalogItemId: null,
            reason: null,
            appliedCatalogItemId: "cat_source_retained",
            appliedMode: "refresh",
            approvalVersion: 3,
            planFingerprint: `sha256:${"c".repeat(64)}`,
          },
          {
            candidateId: "cand_asset",
            status: "failed",
            catalogItemId: null,
            reason: "asset-processing-failed: storage unavailable",
            appliedCatalogItemId: null,
            appliedMode: null,
            approvalVersion: null,
            planFingerprint: null,
            diagnosticCode: "asset-processing-failed",
          },
        ],
      },
    };
    const app = buildApp({
      getBulkReviewJob: vi.fn(async () => null),
      getCatalogMergeCandidateBulkJob: vi.fn(async (jobId: string) =>
        jobId === job.jobId ? job : jobId === legacy.jobId ? legacy : null,
      ),
    } as unknown as SourceObservationRouteServices);

    const response = await app.request("/source-observations/bulk-jobs/job_applied");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(job);
    const legacyResponse = await app.request("/source-observations/bulk-jobs/job_legacy");
    expect(await legacyResponse.json()).toEqual(legacy);
    expect(legacy.result?.outcomes[0]).not.toHaveProperty("appliedCatalogItemId");
  });

  it("fails closed instead of serving a malformed version-1 job", async () => {
    const malformed = new CatalogMergeCandidateBulkJobMalformedError("job_malformed", "invalid application result");
    const app = buildApp({
      getBulkReviewJob: vi.fn(async () => null),
      getCatalogMergeCandidateBulkJob: vi.fn(async () => {
        throw malformed;
      }),
      listCompletedCatalogMergeCandidateBulkJobs: vi.fn(async () => {
        throw malformed;
      }),
    } as unknown as SourceObservationRouteServices);

    expect((await app.request("/source-observations/bulk-jobs/job_malformed")).status).toBe(500);
    const query = new URLSearchParams({
      scopeRecordId: "scope_base_set",
      kind: "merge-candidate-promote",
      status: "completed",
    });
    expect((await app.request(`/source-observations/bulk-jobs/active?${query}`)).status).toBe(500);
  });

  it.each([
    ["unrecognized-synthetic-status", 500],
    [undefined, 500],
    ["skipped-not-eligible", 200],
  ])("serves a stored version-1 outcome with status %s through the runtime reader as %i", async (status, code) => {
    const at = "2026-10-11T00:00:00.000Z";
    const outcome = {
      candidateId: "cand_stored",
      ...(status === undefined ? {} : { status }),
      catalogItemId: null,
      reason: "Synthetic.",
      appliedCatalogItemId: null,
      appliedMode: null,
      approvalVersion: null,
      planFingerprint: null,
    };
    const result = {
      requested: 1,
      promoted: 0,
      deferred: 0,
      skippedNotEligible: status === "skipped-not-eligible" ? 1 : 0,
      failed: 0,
      outcomes: [outcome],
    };
    const payload = { scopeRecordId: "scope_base_set", reason: "Synthetic.", promotionApplicationVersion: 1 };
    const progress = { phase: "completed", completed: 1, total: 1, currentName: null, status: null };
    const stored = {
      jobId: "job_stored",
      jobKind: catalogMergeCandidatePromotionApplicationJobKind,
      status: "completed",
      payload,
      progress,
      result,
      errorMessage: null,
      eventContext: context,
      createdAt: at,
      updatedAt: at,
      startedAt: at,
      completedAt: at,
    };
    const row = {
      job_id: stored.jobId,
      job_kind: stored.jobKind,
      status: "completed",
      payload: JSON.stringify(payload),
      progress: JSON.stringify(progress),
      result: JSON.stringify(result),
      error_message: null,
      created_at: at,
      started_at: at,
      completed_at: at,
      updated_at: at,
      completed_at_key: "2026-10-11T00:00:00.000000Z",
    };
    const runtime = createSourceObservationMergeCandidateBulkJobRuntime({
      deps: { db: { query: vi.fn(async () => ({ rows: [row] })) } },
      jobStore: { get: vi.fn(async () => stored) },
    } as unknown as SourceObservationMergeCandidateBulkJobRuntimeDeps).services;
    const app = buildApp({
      getBulkReviewJob: vi.fn(async () => null),
      getCatalogMergeCandidateBulkJob: runtime.getCatalogMergeCandidateBulkJob,
      listCompletedCatalogMergeCandidateBulkJobs: runtime.listCompletedCatalogMergeCandidateBulkJobs,
    } as unknown as SourceObservationRouteServices);

    const read = await app.request("/source-observations/bulk-jobs/job_stored");
    expect(read.status).toBe(code);
    const query = new URLSearchParams({
      scopeRecordId: "scope_base_set",
      kind: "merge-candidate-promote",
      status: "completed",
    });
    const list = await app.request(`/source-observations/bulk-jobs/active?${query}`);
    expect(list.status).toBe(code);
    if (code === 200) {
      expect(await read.json()).toMatchObject({ promotionApplicationVersion: 1, result });
      expect(await list.json()).toMatchObject({ items: [{ jobId: "job_stored", result }], count: 1 });
    }
  });

  it("enqueues one scope job and returns its reference", async () => {
    const enqueueCatalogMergeCandidateBulkJob = vi.fn(async () => candidateJob("job_scope_promote"));
    const app = buildApp({ enqueueCatalogMergeCandidateBulkJob } as unknown as SourceObservationRouteServices);

    const response = await app.request("/source-observations/merge-candidate-bulk-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "merge-candidate-promote", scopeRecordId: " scope_base_set ", reason: "Seed." }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ jobId: "job_scope_promote", status: "queued" });
    expect(enqueueCatalogMergeCandidateBulkJob).toHaveBeenCalledWith({
      kind: "merge-candidate-promote",
      scopeRecordId: "scope_base_set",
      reason: "Seed.",
      context,
    });
  });

  it.each([
    [null],
    [false],
    [42],
    ["scope_base_set"],
    [[]],
    [{ kind: "promote", scopeRecordId: "scope_base_set" }],
    [{ kind: "merge-candidate-defer", scopeRecordId: "  " }],
    [{ kind: "merge-candidate-promote" }],
  ])("rejects an enqueue without a supported kind and scope: %j", async (body) => {
    const enqueueCatalogMergeCandidateBulkJob = vi.fn();
    const app = buildApp({ enqueueCatalogMergeCandidateBulkJob } as unknown as SourceObservationRouteServices);

    const response = await app.request("/source-observations/merge-candidate-bulk-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(enqueueCatalogMergeCandidateBulkJob).not.toHaveBeenCalled();
  });

  it("denies the enqueue to a view-only operator", async () => {
    const enqueueCatalogMergeCandidateBulkJob = vi.fn();
    const app = buildApp(
      { enqueueCatalogMergeCandidateBulkJob } as unknown as SourceObservationRouteServices,
      undefined,
      viewOnlyActor,
    );

    const response = await app.request("/source-observations/merge-candidate-bulk-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "merge-candidate-promote", scopeRecordId: "scope_base_set" }),
    });

    expect(response.status).toBe(403);
    expect(enqueueCatalogMergeCandidateBulkJob).not.toHaveBeenCalled();
  });

  it("keeps the unfiltered active-job response unchanged", async () => {
    const listActiveBulkReviewJobs = vi.fn(async () => []);
    const listActiveCatalogMergeCandidateBulkJobs = vi.fn();
    const listCompletedCatalogMergeCandidateBulkJobs = vi.fn();
    const app = buildApp({
      listActiveBulkReviewJobs,
      listActiveCatalogMergeCandidateBulkJobs,
      listCompletedCatalogMergeCandidateBulkJobs,
    } as unknown as SourceObservationRouteServices);

    const response = await app.request("/source-observations/bulk-jobs/active");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [], total: 0, count: 0 });
    expect(listActiveBulkReviewJobs).toHaveBeenCalledWith({ context });
    expect(listActiveCatalogMergeCandidateBulkJobs).not.toHaveBeenCalled();
    expect(listCompletedCatalogMergeCandidateBulkJobs).not.toHaveBeenCalled();
  });

  it("reads failed scope jobs separately with retained errors and progress", async () => {
    const failedJob = { ...candidateJob("job_failed", { status: "failed" }), errorMessage: "Missing work units." };
    const listFailedCatalogMergeCandidateBulkJobs = vi.fn(async () => [failedJob]);
    const listCompletedCatalogMergeCandidateBulkJobs = vi.fn();
    const app = buildApp({
      listFailedCatalogMergeCandidateBulkJobs,
      listCompletedCatalogMergeCandidateBulkJobs,
    } as unknown as SourceObservationRouteServices);
    const response = await app.request(
      "/source-observations/merge-candidate-bulk-jobs/failed?scopeRecordId=%20scope_base_set%20",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [failedJob], count: 1 });
    expect(listFailedCatalogMergeCandidateBulkJobs).toHaveBeenCalledWith({ context, scopeRecordId: "scope_base_set" });
    expect(listCompletedCatalogMergeCandidateBulkJobs).not.toHaveBeenCalled();
  });

  it.each(["", "?scopeRecordId=%20"])("requires a scope for failed-job readback: %s", async (query) => {
    const listFailedCatalogMergeCandidateBulkJobs = vi.fn();
    const app = buildApp({ listFailedCatalogMergeCandidateBulkJobs } as unknown as SourceObservationRouteServices);
    expect((await app.request(`/source-observations/merge-candidate-bulk-jobs/failed${query}`)).status).toBe(400);
    expect(listFailedCatalogMergeCandidateBulkJobs).not.toHaveBeenCalled();
  });

  it("checks permission before parsing a non-object enqueue body", async () => {
    const enqueueCatalogMergeCandidateBulkJob = vi.fn();
    const app = buildApp(
      { enqueueCatalogMergeCandidateBulkJob } as unknown as SourceObservationRouteServices,
      undefined,
      viewOnlyActor,
    );
    expect(
      (await app.request("/source-observations/merge-candidate-bulk-jobs", { method: "POST", body: "null" })).status,
    ).toBe(403);
    expect(enqueueCatalogMergeCandidateBulkJob).not.toHaveBeenCalled();
  });

  it("lists a scope's active candidate jobs by scope and kind", async () => {
    const listActiveCatalogMergeCandidateBulkJobs = vi.fn(async () => [candidateJob("job_running")]);
    const app = buildApp({ listActiveCatalogMergeCandidateBulkJobs } as unknown as SourceObservationRouteServices);

    const response = await app.request(
      "/source-observations/bulk-jobs/active?scopeRecordId=scope_base_set&kind=merge-candidate-promote",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ items: [{ jobId: "job_running" }], count: 1 });
    expect(listActiveCatalogMergeCandidateBulkJobs).toHaveBeenCalledWith({
      context,
      scopeRecordId: "scope_base_set",
      kind: "merge-candidate-promote",
    });
  });

  it("follows the completed-job cursor until it is absent, returning every job exactly once", async () => {
    // 51 completed jobs, newest first. Only the oldest promoted the decisive
    // Catalog Item, so it is reachable only by following the cursor.
    const jobs = Array.from({ length: 51 }, (_, index) =>
      candidateJob(`job_${String(51 - index).padStart(2, "0")}`, {
        status: "completed",
        catalogItemId: index === 50 ? "item_decisive" : null,
      }),
    );
    const listCompletedCatalogMergeCandidateBulkJobs = vi.fn(
      async (input: { cursor?: string | null }): Promise<CatalogMergeCandidateBulkJobPage> => {
        const start = input.cursor ? Number(input.cursor) : 0;
        const items = jobs.slice(start, start + 50);
        return start + 50 < jobs.length ? { items, cursor: String(start + 50) } : { items };
      },
    );
    const app = buildApp({ listCompletedCatalogMergeCandidateBulkJobs } as unknown as SourceObservationRouteServices);

    const seen: string[] = [];
    const promotedItems: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const query = new URLSearchParams({
        scopeRecordId: "scope_base_set",
        kind: "merge-candidate-promote",
        status: "completed",
      });
      if (cursor) {
        query.set("cursor", cursor);
      }
      const response = await app.request(`/source-observations/bulk-jobs/active?${query}`);
      expect(response.status).toBe(200);
      const page = (await response.json()) as CatalogMergeCandidateBulkJobPage & { count: number };
      expect(page.items.length).toBeLessThanOrEqual(50);
      expect(page.count).toBe(page.items.length);
      seen.push(...page.items.map((job) => job.jobId));
      promotedItems.push(
        ...page.items.flatMap(
          (job) => job.result?.outcomes.flatMap((o) => (o.catalogItemId ? [o.catalogItemId] : [])) ?? [],
        ),
      );
      cursor = page.cursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(2);
    expect(seen).toHaveLength(51);
    expect(new Set(seen).size).toBe(51);
    expect(promotedItems).toEqual(["item_decisive"]);
    expect(listCompletedCatalogMergeCandidateBulkJobs).toHaveBeenNthCalledWith(1, {
      context,
      scopeRecordId: "scope_base_set",
      kind: "merge-candidate-promote",
      cursor: null,
    });
    expect(listCompletedCatalogMergeCandidateBulkJobs).toHaveBeenNthCalledWith(2, {
      context,
      scopeRecordId: "scope_base_set",
      kind: "merge-candidate-promote",
      cursor: "50",
    });
  });

  it.each([["status=running"], ["kind=promote&status=completed"], ["scopeRecordId=scope_base_set&cursor=abc"]])(
    "rejects unsupported list filters: %s",
    async (query) => {
      const listActiveBulkReviewJobs = vi.fn();
      const listCompletedCatalogMergeCandidateBulkJobs = vi.fn();
      const app = buildApp({
        listActiveBulkReviewJobs,
        listCompletedCatalogMergeCandidateBulkJobs,
      } as unknown as SourceObservationRouteServices);

      const response = await app.request(`/source-observations/bulk-jobs/active?${query}`);

      expect(response.status).toBe(400);
      expect(listActiveBulkReviewJobs).not.toHaveBeenCalled();
      expect(listCompletedCatalogMergeCandidateBulkJobs).not.toHaveBeenCalled();
    },
  );

  it("rejects a malformed completed-job cursor", async () => {
    const listCompletedCatalogMergeCandidateBulkJobs = vi.fn(async () => {
      throw new CatalogMergeCandidateBulkJobCursorError();
    });
    const app = buildApp({ listCompletedCatalogMergeCandidateBulkJobs } as unknown as SourceObservationRouteServices);

    const response = await app.request(
      "/source-observations/bulk-jobs/active?scopeRecordId=scope_base_set&status=completed&cursor=not-a-cursor",
    );

    expect(response.status).toBe(400);
  });

  it("reads a candidate scope job by id when it is not an observation bulk job", async () => {
    const getBulkReviewJob = vi.fn(async () => null);
    const getCatalogMergeCandidateBulkJob = vi.fn(async () => candidateJob("job_scope_promote"));
    const app = buildApp({
      getBulkReviewJob,
      getCatalogMergeCandidateBulkJob,
    } as unknown as SourceObservationRouteServices);

    const response = await app.request("/source-observations/bulk-jobs/job_scope_promote");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job_scope_promote",
      kind: "merge-candidate-promote",
      scopeRecordId: "scope_base_set",
    });
    expect(getCatalogMergeCandidateBulkJob).toHaveBeenCalledWith("job_scope_promote", context);
  });
});

function candidateJob(
  jobId: string,
  input: Readonly<{ status?: CatalogMergeCandidateBulkJob["status"]; catalogItemId?: string | null }> = {},
): CatalogMergeCandidateBulkJob {
  const completed = input.status === "completed";
  return {
    jobId,
    kind: "merge-candidate-promote",
    promotionApplicationVersion: null,
    scopeRecordId: "scope_base_set",
    reason: "Promote all ready candidates in the scope.",
    status: input.status ?? "queued",
    progress: {
      phase: completed ? "completed" : "queued",
      completed: completed ? 1 : 0,
      total: 1,
      currentName: null,
      status: null,
    },
    result: completed
      ? {
          requested: 1,
          promoted: 1,
          deferred: 0,
          skippedNotEligible: 0,
          failed: 0,
          outcomes: [
            {
              candidateId: `cand_${jobId}`,
              status: "promoted",
              catalogItemId: input.catalogItemId ?? null,
              reason: null,
            },
          ],
        }
      : null,
    errorMessage: null,
    createdAt: "2026-10-09T00:00:00.000Z",
    startedAt: null,
    completedAt: completed ? "2026-10-09T00:01:00.000Z" : null,
    updatedAt: "2026-10-09T00:01:00.000Z",
  };
}
