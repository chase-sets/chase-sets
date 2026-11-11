import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createPostgresDurableJobStore,
  type DurableJobRecord,
  type DurableJobStore,
} from "@chase-sets/platform-runtime/durable-job-store";
import {
  createPostgresDurableJobWorkUnitStore,
  type DurableJobWorkUnitStore,
} from "@chase-sets/platform-runtime/durable-job-work-units";
import {
  createCatalogAuthoringBulkJobServices,
  parseEditOperation,
  type CatalogAuthoringBulkJobPayload,
  type CatalogAuthoringBulkJobProgress,
} from "./bulk-authoring-jobs";
import type { CatalogServices } from "./services";
import { removalContext } from "../../features/catalog-items/api/bulk-remove-drafts-test-harness";

vi.mock("@chase-sets/platform-runtime/durable-job-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/platform-runtime/durable-job-store")>()),
  createPostgresDurableJobStore: vi.fn(),
}));
vi.mock("@chase-sets/platform-runtime/durable-job-work-units", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/platform-runtime/durable-job-work-units")>()),
  createPostgresDurableJobWorkUnitStore: vi.fn(),
}));

const kind = "catalog.authoring.items.remove-drafts" as const;
type Job = DurableJobRecord<CatalogAuthoringBulkJobPayload, CatalogAuthoringBulkJobProgress, unknown>;
type Units = DurableJobWorkUnitStore<
  CatalogAuthoringBulkJobPayload,
  CatalogAuthoringBulkJobProgress,
  unknown,
  { itemId: string },
  { itemId: string; result: unknown }
>;
const timestamp = "2026-11-09T00:00:00.000Z";
const job = (overrides: Partial<Job> = {}): Job => ({
  jobId: "job_removal",
  jobKind: kind,
  status: "queued",
  payload: { kind, action: "remove-drafts", itemIds: ["cat_1"] },
  progress: { phase: "queued", completed: 0, total: 1, currentName: null, status: null },
  result: null,
  errorMessage: null,
  eventContext: removalContext,
  claimOwnerId: null,
  claimedUntil: null,
  attemptCount: 0,
  nextEligibleAt: timestamp,
  createdAt: timestamp,
  startedAt: null,
  completedAt: null,
  updatedAt: timestamp,
  ...overrides,
});
function itemResult(outcome: "succeeded" | "skipped" | "failed", id = "cat_1") {
  return {
    item_ids: [id],
    total: 1,
    succeeded_count: Number(outcome === "succeeded"),
    skipped_count: Number(outcome === "skipped"),
    failed_count: Number(outcome === "failed"),
    candidates: [
      {
        catalog_item_id: id,
        title: id,
        status: outcome === "succeeded" ? "removed" : "active",
        outcome,
        reason:
          outcome === "skipped"
            ? "Only draft items can be removed."
            : outcome === "failed"
              ? "Catalog Item removal failed."
              : null,
      },
    ],
  };
}
function claim(parent = job()) {
  return {
    job: parent,
    unit: {
      jobId: parent.jobId,
      unitId: "cat_1",
      unitKind: kind,
      payload: { itemId: "cat_1" },
      state: "running" as const,
      result: null,
      errorMessage: null,
      claimOwnerId: "worker",
      claimToken: "token",
      claimedUntil: timestamp,
      attemptCount: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    },
    workflowName: "catalog.authoring-bulk",
    laneName: null,
    claimOwnerId: "worker",
    claimToken: "token",
  };
}
const claimOutcome = {
  workflowName: "catalog.authoring-bulk",
  laneName: null,
  claimed: false,
  reason: "none_available" as const,
  activeClaims: 0,
  workflowMaxActiveClaims: 1,
  jobMaxActiveClaims: 1,
};

function workerHarness() {
  const parentStore = {
    enqueue: vi.fn(
      async (input: {
        jobId: string;
        payload: CatalogAuthoringBulkJobPayload;
        progress: CatalogAuthoringBulkJobProgress;
      }) => job(input),
    ),
    claimNext: vi
      .fn<DurableJobStore<CatalogAuthoringBulkJobPayload, CatalogAuthoringBulkJobProgress, unknown>["claimNext"]>()
      .mockResolvedValue(null),
    get: vi.fn(async () => job()),
    listEvents: vi.fn(async () => []),
  };
  const unitStore = {
    enqueue: vi.fn<Units["enqueue"]>().mockResolvedValue(0),
    claimNext: vi.fn<Units["claimNext"]>().mockResolvedValue({ claim: null, outcome: claimOutcome }),
    recordTerminal: vi.fn<Units["recordTerminal"]>().mockResolvedValue("recorded"),
    releaseClaim: vi.fn<Units["releaseClaim"]>().mockResolvedValue(true),
  };
  vi.mocked(createPostgresDurableJobStore).mockReturnValue(parentStore as never);
  vi.mocked(createPostgresDurableJobWorkUnitStore).mockReturnValue(unitStore as never);
  const removeDraftsBulk = vi
    .fn<CatalogServices["items"]["removeDraftsBulk"]>()
    .mockResolvedValue(itemResult("succeeded"));
  const services = { items: { removeDraftsBulk } } as unknown as CatalogServices;
  const jobs = createCatalogAuthoringBulkJobServices({ query: async () => ({ rows: [] }) });
  return {
    jobs,
    services,
    removeDraftsBulk,
    parentStore,
    unitStore,
    process: () => jobs.processNext({ claimOwnerId: "worker", services }),
  };
}

describe("bulk draft removal jobs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("J1: never parent-claims work-unit-only removal or publish jobs after a unit miss", async () => {
    const h = workerHarness();
    expect(await h.process()).toBe(false);
    expect(h.parentStore.claimNext).toHaveBeenCalledWith(expect.objectContaining({ jobKinds: expect.any(Array) }));
    const options = h.parentStore.claimNext.mock.calls[0]![0];
    expect(options.jobKinds).not.toContain(kind);
    expect(options.jobKinds).not.toContain("catalog.authoring.items.publish");
    expect(h.removeDraftsBulk).not.toHaveBeenCalled();
  });

  it("J2: deduplicates enqueue ids, total and units and rejects empty ids", async () => {
    const h = workerHarness();
    await h.jobs.enqueue({
      kind,
      action: "remove-drafts",
      itemIds: ["cat_1", "cat_2", "cat_1"],
      context: removalContext,
    });
    expect(h.parentStore.enqueue).toHaveBeenCalledTimes(1);
    expect(h.parentStore.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ itemIds: ["cat_1", "cat_2"] }),
        progress: expect.objectContaining({ total: 2 }),
      }),
    );
    expect(h.unitStore.enqueue).toHaveBeenCalledTimes(1);
    expect(h.unitStore.enqueue).toHaveBeenCalledWith({
      jobId: expect.any(String),
      units: [
        { unitId: "cat_1", unitKind: kind, payload: { itemId: "cat_1" } },
        { unitId: "cat_2", unitKind: kind, payload: { itemId: "cat_2" } },
      ],
    });
    await expect(
      h.jobs.enqueue({ kind, action: "remove-drafts", itemIds: [], context: removalContext }),
    ).rejects.toThrow("requires at least one Catalog Item");
    expect(h.parentStore.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["succeeded", "completed"],
    ["skipped", "skipped"],
    ["failed", "failed"],
  ] as const)("J3: preserves enqueue attribution and maps %s to %s", async (outcome, state) => {
    const h = workerHarness();
    h.unitStore.claimNext.mockResolvedValueOnce({ claim: claim(), outcome: claimOutcome });
    h.removeDraftsBulk.mockResolvedValueOnce(itemResult(outcome));
    expect(await h.process()).toBe(true);
    expect(h.removeDraftsBulk).toHaveBeenCalledWith(
      ["cat_1"],
      removalContext,
      expect.objectContaining({ throwIfCancelled: expect.any(Function) }),
    );
    expect(h.unitStore.recordTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ state, errorMessage: outcome === "failed" ? "Catalog Item removal failed." : null }),
    );
  });

  it("J4: reconciles removal counts and completes only after every terminal unit", async () => {
    const h = workerHarness();
    h.unitStore.claimNext.mockResolvedValueOnce({
      claim: claim(
        job({
          payload: { kind, action: "remove-drafts", itemIds: ["cat_1", "cat_2", "cat_3"] },
          progress: { phase: "running", completed: 0, total: 3, currentName: null, status: null },
        }),
      ),
      outcome: claimOutcome,
    });
    await h.process();
    const resolve = h.unitStore.recordTerminal.mock.calls[0]![0].resolveParentUpdate!;
    const rows = ["succeeded", "skipped", "failed"].map((outcome, index) => ({
      unit_id: `cat_${index + 1}`,
      unit_kind: kind,
      state: outcome === "succeeded" ? "completed" : outcome,
      payload: { itemId: `cat_${index + 1}` },
      result: {
        itemId: `cat_${index + 1}`,
        result: itemResult(outcome as "succeeded" | "skipped" | "failed", `cat_${index + 1}`),
      },
      error_message: null,
      claim_owner_id: null,
      claim_token: null,
      claimed_until: null,
      attempt_count: 1,
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: timestamp,
    }));
    const db: PgQueryable = { query: async <T>() => ({ rows: rows as T[] }) };
    const partial = await resolve({
      query: async <T>() => ({ rows: [rows[0], rows[1], { ...rows[2], state: "running", result: null }] as T[] }),
    });
    expect(partial).toMatchObject({
      completeJob: false,
      parentProgress: { completed: 2, total: 3 },
      parentResult: { total: 2, succeeded_count: 1, skipped_count: 1, failed_count: 0 },
    });
    const complete = await resolve(db);
    expect(complete).toMatchObject({
      completeJob: true,
      parentProgress: { completed: 3, total: 3 },
      parentResult: { total: 3, succeeded_count: 1, skipped_count: 1, failed_count: 1 },
    });
    expect(complete.parentResult).not.toHaveProperty("published_count");
    expect(complete.parentResult).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({ outcome: "skipped", reason: "Only draft items can be removed." }),
      ]),
    });
  });

  it("J5: releases a handed-off claim and redelivers that unit with exactly one terminal", async () => {
    const h = workerHarness();
    h.unitStore.claimNext
      .mockResolvedValueOnce({ claim: claim(), outcome: claimOutcome })
      .mockResolvedValueOnce({ claim: claim(), outcome: claimOutcome });
    h.removeDraftsBulk.mockRejectedValueOnce(new Error("Lost lease synthetic handoff"));
    expect(await h.process()).toBe(false);
    expect(h.unitStore.releaseClaim).toHaveBeenCalledTimes(1);
    expect(h.unitStore.recordTerminal).not.toHaveBeenCalled();
    expect(await h.process()).toBe(true);
    expect(await h.process()).toBe(false);
    expect(h.unitStore.recordTerminal).toHaveBeenCalledTimes(1);
    expect(h.unitStore.recordTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ unitId: "cat_1", state: "completed" }),
    );
  });

  it("J6: retains completed results across reconnect and idle polling and refuses another tenant", async () => {
    const h = workerHarness();
    const retained = job({
      status: "completed",
      result: itemResult("succeeded"),
      progress: { phase: "completed", completed: 1, total: 1, currentName: null, status: null },
    });
    h.parentStore.get.mockResolvedValue(retained);
    const first = await h.jobs.get(retained.jobId, removalContext);
    expect(first?.result).toEqual(itemResult("succeeded"));
    expect(await h.jobs.get(retained.jobId, removalContext)).toEqual(first);
    expect(await h.process()).toBe(false);
    expect(await h.jobs.get(retained.jobId, removalContext)).toEqual(first);
    const foreign = { ...removalContext, tenantId: "tnt_other" as never };
    expect(await h.jobs.get(retained.jobId, foreign)).toBeNull();
    expect(await h.jobs.listEvents(retained.jobId, 0, foreign)).toEqual([]);
    expect(h.parentStore.listEvents).not.toHaveBeenCalled();
  });
});

describe("catalog authoring bulk job operation parser", () => {
  it("accepts valid Catalog Item bulk edit operations", () => {
    expect(parseEditOperation({ action: "mergeTags", tags: ["featured", "foil"] })).toEqual({
      action: "mergeTags",
      tags: ["featured", "foil"],
    });
    expect(parseEditOperation({ action: "clearTags" })).toEqual({ action: "clearTags" });
  });

  it("rejects malformed Catalog Item bulk edit operations", () => {
    expect(() => parseEditOperation({ action: "mergeTags", tags: ["featured", 10] })).toThrow(
      "Catalog Item bulk edit operation is invalid.",
    );
    expect(() => parseEditOperation({ action: "assignCategory" })).toThrow(
      "Catalog Item bulk edit operation is invalid.",
    );
  });
});
