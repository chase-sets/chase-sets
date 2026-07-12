import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { catalogItemRoutes } from "./route";
import type { CatalogItemServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { CatalogAuthoringBulkJobServices } from "../../../support/authoring-support/bulk-authoring-jobs";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

function buildApp(
  services: CatalogItemServices,
  authoringBulkJobs: CatalogAuthoringBulkJobServices = createJobServices(),
) {
  const app = new Hono<CatalogAuthoringEnv>();
  app.use("*", async (c, next) => {
    c.set("context", context);
    await next();
  });
  app.route("/items", catalogItemRoutes(services, authoringBulkJobs));
  return app;
}

function createJobServices(overrides: Partial<CatalogAuthoringBulkJobServices> = {}): CatalogAuthoringBulkJobServices {
  return {
    enqueue: async (input) => ({
      jobId: "job_test",
      kind: input.kind,
      action: input.action,
      status: "queued",
      progress: { phase: "queued", completed: 0, total: 1, currentName: null, status: "queued" },
      result: null,
      errorMessage: null,
      createdAt: "2026-05-28T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-05-28T00:00:00.000Z",
    }),
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

function createServices(overrides: Partial<CatalogItemServices> = {}): CatalogItemServices {
  return {
    commandHandler: async () => {
      throw new Error("command handler not expected");
    },
    listCatalogItems: async () => ({ items: [], total: 0 }),
    getCatalogItemDetail: async () => null as never,
    getCatalogItemByGtin: async () => null,
    previewBulkPublish: async () => ({
      mode: "ids",
      item_ids: [],
      total: 0,
      ready_count: 0,
      blocked_count: 0,
      candidates: [],
    }),
    publishBulk: async () => ({
      item_ids: [],
      total: 0,
      published_count: 0,
      failed_count: 0,
      skipped_count: 0,
      candidates: [],
    }),
    previewBulkEdit: async () => ({
      mode: "ids",
      action: "assignCategory",
      item_ids: [],
      total: 0,
      ready_count: 0,
      blocked_count: 0,
      candidates: [],
    }),
    editBulk: async () => ({
      action: "assignCategory",
      item_ids: [],
      total: 0,
      succeeded_count: 0,
      skipped_count: 0,
      failed_count: 0,
      candidates: [],
    }),
    processDisplayIdentityRecomputeBatch: async () => ({
      selected: 0,
      processed: 0,
      changed: 0,
      unchanged: 0,
      missing: 0,
      failed: 0,
    }),
    getDisplayIdentityRecomputeHealth: async () => ({
      pending: 0,
      running: 0,
      completed: 0,
      pendingWithError: 0,
      oldestPendingAt: null,
      latestFailureMessage: null,
    }),
    purgeCompletedDisplayIdentityRecomputeWork: async () => 0,
    bulkLifecycle: {
      preview: async () => ({
        mode: "ids",
        action: "archive",
        ids: [],
        total: 0,
        ready_count: 0,
        blocked_count: 0,
        candidates: [],
      }),
      execute: async () => ({
        action: "archive",
        ids: [],
        total: 0,
        succeeded_count: 0,
        skipped_count: 0,
        failed_count: 0,
        candidates: [],
      }),
    },
    projectors: [],
    ...overrides,
  };
}

describe("catalog item routes", () => {
  it("passes source filters into the Catalog Item list query", async () => {
    const listCatalogItems = vi.fn(async () => ({ items: [], total: 0 }));
    const app = buildApp(createServices({ listCatalogItems }));

    const response = await app.fetch(
      new Request("http://catalog.test/items?status=draft&source=tcgplayer&language=en"),
    );

    expect(response.status).toBe(200);
    expect(listCatalogItems).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "draft",
        source: "tcgplayer",
        language: "en",
      }),
    );
  });

  it("renders an empty filtered list for an unknown source provider deep-link without erroring", async () => {
    const listCatalogItems = vi.fn(async () => ({ items: [], total: 0 }));
    const app = buildApp(createServices({ listCatalogItems }));

    const response = await app.fetch(new Request("http://catalog.test/items?source=not-a-real-provider"));

    expect(response.status).toBe(200);
    expect(listCatalogItems).toHaveBeenCalledWith(expect.objectContaining({ source: "not-a-real-provider" }));
    const body = (await response.json()) as { items: unknown[]; total: number; count: number };
    expect(body).toEqual({ items: [], total: 0, count: 0 });
  });

  it("passes workflow filters into the Catalog Item list query", async () => {
    const listCatalogItems = vi.fn(async () => ({ items: [], total: 0 }));
    const app = buildApp(createServices({ listCatalogItems }));

    const response = await app.fetch(
      new Request(
        "http://catalog.test/items?blueprintId=bp_1&tag=foil&blueprintState=assigned&hasImages=true&hasSourceReferences=false&missingRequiredFields=true",
      ),
    );

    expect(response.status).toBe(200);
    expect(listCatalogItems).toHaveBeenCalledWith(
      expect.objectContaining({
        blueprintId: "bp_1",
        tag: "foil",
        blueprintState: "assigned",
        hasImages: "true",
        hasSourceReferences: "false",
        missingRequiredFields: "true",
      }),
    );
  });

  it("previews filter-wide bulk publish against the requested filtered scope", async () => {
    const previewBulkPublish = vi.fn(async () => ({
      mode: "filter" as const,
      item_ids: ["cat_1"],
      total: 1,
      ready_count: 1,
      blocked_count: 0,
      candidates: [],
    }));
    const app = buildApp(createServices({ previewBulkPublish }));

    const response = await app.fetch(
      new Request("http://catalog.test/items/bulk-publish/preview", {
        method: "POST",
        body: JSON.stringify({
          selection: {
            mode: "filter",
            query: {
              status: "active",
              source: "tcgplayer",
              blueprintState: "assigned",
              hasImages: "true",
              hasSourceReferences: "true",
              missingRequiredFields: "false",
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(previewBulkPublish).toHaveBeenCalledWith({
      mode: "filter",
      query: {
        search: undefined,
        status: "active",
        blueprintId: undefined,
        tag: undefined,
        language: undefined,
        source: "tcgplayer",
        blueprintState: "assigned",
        hasImages: "true",
        hasSourceReferences: "true",
        missingRequiredFields: "false",
      },
    });
  });

  it("confirms bulk publish against explicit previewed IDs", async () => {
    const enqueue = vi.fn(createJobServices().enqueue);
    const app = buildApp(createServices(), createJobServices({ enqueue }));

    const response = await app.fetch(
      new Request("http://catalog.test/items/bulk-publish/confirm", {
        method: "POST",
        body: JSON.stringify({ itemIds: ["cat_1", "cat_2"] }),
      }),
    );

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith({
      kind: "catalog.authoring.items.publish",
      action: "publish",
      itemIds: ["cat_1", "cat_2"],
      context,
    });
  });

  it("previews lifecycle actions against the filtered item scope", async () => {
    const preview = vi.fn(async () => ({
      mode: "filter" as const,
      action: "archive",
      ids: ["cat_1"],
      total: 1,
      ready_count: 1,
      blocked_count: 0,
      candidates: [],
    }));
    const app = buildApp(
      createServices({
        bulkLifecycle: {
          preview,
          execute: async () => ({
            action: "archive",
            ids: [],
            total: 0,
            succeeded_count: 0,
            skipped_count: 0,
            failed_count: 0,
            candidates: [],
          }),
        },
      }),
    );

    const response = await app.fetch(
      new Request("http://catalog.test/items/bulk-lifecycle/preview", {
        method: "POST",
        body: JSON.stringify({
          action: "archive",
          selection: {
            mode: "filter",
            query: {
              status: "active",
              blueprintId: "bp_1",
              tag: "foil",
              language: "en",
              source: "tcgdex",
              blueprintState: "assigned",
              hasImages: "true",
              hasSourceReferences: "true",
              missingRequiredFields: "false",
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(preview).toHaveBeenCalledWith(
      {
        mode: "filter",
        query: {
          search: undefined,
          status: "active",
          blueprintId: "bp_1",
          tag: "foil",
          language: "en",
          source: "tcgdex",
          blueprintState: "assigned",
          hasImages: "true",
          hasSourceReferences: "true",
          missingRequiredFields: "false",
        },
      },
      "archive",
    );
  });

  it("previews shared bulk edits against the filtered item scope", async () => {
    const previewBulkEdit = vi.fn(async () => ({
      mode: "filter" as const,
      action: "assignCategory" as const,
      item_ids: ["cat_1"],
      total: 1,
      ready_count: 1,
      blocked_count: 0,
      candidates: [],
    }));
    const app = buildApp(createServices({ previewBulkEdit }));

    const response = await app.fetch(
      new Request("http://catalog.test/items/bulk-edit/preview", {
        method: "POST",
        body: JSON.stringify({
          operation: { action: "assignCategory", categoryId: "cat_pokemon" },
          selection: {
            mode: "filter",
            query: {
              status: "active",
              blueprintId: "bp_1",
              tag: "foil",
              language: "en",
              source: "tcgdex",
              hasSourceReferences: "true",
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(previewBulkEdit).toHaveBeenCalledWith(
      {
        mode: "filter",
        query: {
          search: undefined,
          status: "active",
          blueprintId: "bp_1",
          tag: "foil",
          language: "en",
          source: "tcgdex",
          blueprintState: undefined,
          hasImages: undefined,
          hasSourceReferences: "true",
          missingRequiredFields: undefined,
        },
      },
      { action: "assignCategory", categoryId: "cat_pokemon" },
    );
  });

  it("confirms shared bulk tag edits against selected item IDs", async () => {
    const enqueue = vi.fn(createJobServices().enqueue);
    const app = buildApp(createServices(), createJobServices({ enqueue }));

    const response = await app.fetch(
      new Request("http://catalog.test/items/bulk-edit/confirm", {
        method: "POST",
        body: JSON.stringify({
          operation: { action: "mergeTags", tags: ["featured", "foil"] },
          selection: { mode: "ids", ids: ["cat_1", "cat_2"] },
        }),
      }),
    );

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith({
      kind: "catalog.authoring.items.edit",
      action: "mergeTags",
      selection: { mode: "ids", ids: ["cat_1", "cat_2"] },
      operation: { action: "mergeTags", tags: ["featured", "foil"] },
      context,
    });
  });

  it("removes a draft Catalog Item", async () => {
    const commandHandler = vi.fn(async () => ({
      version: 2,
      state: { status: "removed" },
    }));
    const app = buildApp(createServices({ commandHandler } as unknown as Partial<CatalogItemServices>));

    const response = await app.fetch(new Request("http://catalog.test/items/cat_1", { method: "DELETE" }));

    expect(response.status).toBe(200);
    expect(commandHandler).toHaveBeenCalledWith({
      streamId: "catalog.item-cat_1",
      command: { type: "RemoveDraftCatalogItem" },
      context,
    });
    await expect(response.json()).resolves.toMatchObject({ id: "cat_1", status: "removed" });
  });
});
