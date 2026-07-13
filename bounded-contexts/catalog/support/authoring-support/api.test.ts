import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  CatalogAuthoringBulkJob,
  CatalogAuthoringBulkJobEvent,
  CatalogAuthoringBulkJobServices,
} from "./bulk-authoring-jobs";
import { buildCatalogAuthoringTestApp } from "./test-support";
import type { CatalogServices } from "./services";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

describe("Catalog authoring API", () => {
  it("returns scoped active bulk authoring jobs", async () => {
    const activeJob = job({ jobId: "job_active", status: "running" });
    const listActive = vi.fn(async () => [activeJob]);
    const app = buildCatalogAuthoringTestApp(createServices({ listActive }), context);

    const response = await app.fetch(new Request("http://catalog.test/api/catalog/bulk-authoring-jobs/active"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [activeJob], total: 1, count: 1 });
    expect(listActive).toHaveBeenCalledWith(context);
  });

  it("returns controlled JSON when a bulk authoring job is outside the request scope", async () => {
    const get = vi.fn(async () => null);
    const app = buildCatalogAuthoringTestApp(createServices({ get }), context);

    const response = await app.fetch(new Request("http://catalog.test/api/catalog/bulk-authoring-jobs/job_missing"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Catalog authoring bulk job not found.",
      },
    });
    expect(get).toHaveBeenCalledWith("job_missing", context);
  });

  it("streams durable bulk authoring job events with scoped lookups", async () => {
    const completedJob = job({ jobId: "job_completed", status: "completed" });
    const get = vi.fn(async () => completedJob);
    const listEvents = vi.fn(async (_jobId: string, _afterSequence = 0, _context?: EventStoreContext | null) => [
      event({ sequence: 1, job: completedJob }),
    ]);
    const app = buildCatalogAuthoringTestApp(createServices({ get, listEvents }), context);

    const response = await app.fetch(
      new Request("http://catalog.test/api/catalog/bulk-authoring-jobs/job_completed/events"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("id: 1");
    expect(body).toContain("event: status");
    expect(body).toContain('"jobId":"job_completed"');
    expect(body).toContain('"status":"completed"');
    expect(get).toHaveBeenCalledWith("job_completed", context);
    expect(listEvents).toHaveBeenCalledWith("job_completed", 0, context);
  });

  it("does not open an event stream for an out-of-scope bulk authoring job", async () => {
    const get = vi.fn(async () => null);
    const listEvents = vi.fn(async () => []);
    const app = buildCatalogAuthoringTestApp(createServices({ get, listEvents }), context);

    const response = await app.fetch(
      new Request("http://catalog.test/api/catalog/bulk-authoring-jobs/job_other/events"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Catalog authoring bulk job not found.",
      },
    });
    expect(get).toHaveBeenCalledWith("job_other", context);
    expect(listEvents).not.toHaveBeenCalled();
  });
});

function createServices(overrides: Partial<CatalogAuthoringBulkJobServices> = {}): CatalogServices {
  return {
    dimensions: {} as never,
    displayTemplates: {} as never,
    fields: {} as never,
    referenceData: {} as never,
    components: {} as never,
    blueprints: {} as never,
    categories: {} as never,
    items: {} as never,
    productContents: {} as never,
    productMeasures: {} as never,
    scopeRegistry: {} as never,
    providerScopeMappings: {} as never,
    providerIntegrationProfiles: {} as never,
    sourceObservations: {} as never,
    catalogAliases: {} as never,
    attentionQueue: {} as never,
    authoringBulkJobs: createBulkJobServices(overrides),
    projectors: [],
    pool: {} as never,
    db: {} as never,
  };
}

function createBulkJobServices(
  overrides: Partial<CatalogAuthoringBulkJobServices> = {},
): CatalogAuthoringBulkJobServices {
  return {
    enqueue: async () => {
      throw new Error("enqueue not expected");
    },
    get: async () => null,
    listActive: async () => [],
    listEvents: async () => [],
    waitForEvents: async () => undefined,
    pruneRetention: async () => 0,
    processNext: async () => false,
    getWorkUnitSummary: async () => ({
      workflowName: "catalog.authoring-bulk",
      jobId: null,
      total: 0,
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      activeClaims: 0,
      expiredClaims: 0,
    }),
    ...overrides,
  };
}

function job(overrides: Partial<CatalogAuthoringBulkJob> = {}): CatalogAuthoringBulkJob {
  const status = overrides.status ?? "queued";
  return {
    jobId: "job_test",
    kind: "catalog.authoring.items.edit",
    action: "bulk-edit",
    status,
    progress: { phase: status, completed: status === "completed" ? 1 : 0, total: 1, currentName: null, status },
    result: null,
    errorMessage: null,
    createdAt: "2026-06-30T00:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-06-30T00:00:01.000Z",
    completedAt: status === "completed" ? "2026-06-30T00:00:02.000Z" : null,
    updatedAt: "2026-06-30T00:00:02.000Z",
    ...overrides,
  };
}

function event(input: { sequence: number; job: CatalogAuthoringBulkJob }): CatalogAuthoringBulkJobEvent {
  return {
    sequence: input.sequence,
    eventName: "status",
    job: input.job,
    snapshot: input.job,
    createdAt: input.job.createdAt,
  };
}
