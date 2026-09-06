import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { catalogItemRoutes } from "../features/catalog-items/api/route";
import type {
  BulkEditCatalogItemPreview,
  CatalogItemDetailWithPublicationReadiness,
  CatalogItemServices,
} from "../features/catalog-items/api/runtime";
import type { CatalogItemState } from "../features/catalog-items/domain/domain";
import type { CatalogItemDetailRow } from "../features/catalog-items/read-model/queries";
import type { CatalogAuthoringEnv } from "../support/authoring-support/api";
import type { CatalogAuthoringBulkJobServices } from "../support/authoring-support/bulk-authoring-jobs";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

const englishName = {
  defaultLocale: "en",
  values: {
    en: "Furret",
  },
} as const;

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

function jsonRequest(path: string, body: unknown, method = "POST") {
  return new Request(`http://catalog.test${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function commandResult<State extends Readonly<{ status: string }>>(state: State, version = 2) {
  return {
    version,
    state,
    newEvents: [],
    storedEvents: [],
  };
}

function createJobServices(overrides: Partial<CatalogAuthoringBulkJobServices> = {}): CatalogAuthoringBulkJobServices {
  return {
    enqueue: async (input) => ({
      jobId: "job_catalog_items",
      kind: input.kind,
      action: input.action,
      status: "queued",
      progress: { phase: "queued", completed: 0, total: 2, currentName: null, status: "queued" },
      result: null,
      errorMessage: null,
      createdAt: "2026-06-15T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-06-15T00:00:00.000Z",
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
      action: "setTags",
      item_ids: [],
      total: 0,
      ready_count: 0,
      blocked_count: 0,
      candidates: [],
    }),
    editBulk: async () => ({
      action: "setTags",
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

function staleCatalogItemDetailRow(): CatalogItemDetailRow {
  return {
    catalog_item_id: "cat_furret",
    language_code: "en",
    title_i18n: englishName,
    title: "Stale Furret",
    subtitle_i18n: null,
    subtitle: null,
    display_template_key: null,
    display_identity_hash: null,
    display_identity_resolved_at: null,
    description_i18n: englishName,
    description: "Stale projection detail",
    blueprint_id: "bpr_pokemon_card",
    blueprint: null,
    status: "draft",
    field_values: [],
    categories: [],
    external_catalog_item_references: [],
    external_product_references: [],
    tags: ["stale-projection"],
    image_urls: [],
    product_asset_sets: [],
    image_fallback: null,
    updated_at: "2026-06-15T00:00:00.000Z",
  };
}

describe("catalog item mutation consistency", () => {
  it("returns committed Catalog Item command snapshots without reading stale detail projections", async () => {
    const getCatalogItemDetail = vi.fn(
      async (): Promise<CatalogItemDetailWithPublicationReadiness> => ({
        ...staleCatalogItemDetailRow(),
        display_identity_publication: {
          status: "outdated",
          reason_code: "display-identity-outdated",
          missing_tokens: [],
          retryable: true,
        },
      }),
    );
    const commandSnapshot = {
      id: "cat_furret",
      languageCode: "en",
      title: englishName,
      subtitle: null,
      description: englishName,
      blueprintId: "bpr_pokemon_card",
      status: "active",
      fieldValues: [{ fieldId: "fld_card_name", value: "Furret" }],
      categoryIds: ["ctg_pokemon"],
      tags: ["featured", "furret"],
      imageUrls: ["https://img.example/furret.png"],
      productAssetSets: [],
      imageFallback: {
        url: "https://img.example/furret-fallback.png",
        alt: "Furret fallback",
        usage: "permanent",
        variants: {},
      },
      externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:123" }],
      externalProductReferences: [
        {
          providerKey: "tcgplayer",
          externalKey: "sku:456",
          selectedOptions: [{ dimensionId: "dim_finish", optionId: "opt_holo" }],
        },
      ],
      gtins: [],
    } satisfies CatalogItemState;
    const commandHandler = vi.fn(async () => commandResult(commandSnapshot, 9));
    const app = buildApp(createServices({ commandHandler, getCatalogItemDetail }));

    const response = await app.fetch(jsonRequest("/items/cat_furret/tags", { tags: ["furret", "featured"] }, "PUT"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "cat_furret",
      version: 9,
      status: "active",
      snapshot: {
        id: "cat_furret",
        status: "active",
        fieldValues: [{ fieldId: "fld_card_name", value: "Furret" }],
        categoryIds: ["ctg_pokemon"],
        tags: ["featured", "furret"],
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:123" }],
        externalProductReferences: [
          {
            providerKey: "tcgplayer",
            externalKey: "sku:456",
            selectedOptions: [{ dimensionId: "dim_finish", optionId: "opt_holo" }],
          },
        ],
      },
    });
    expect(getCatalogItemDetail).not.toHaveBeenCalled();
  });

  it("returns Catalog Item bulk preview snapshots and durable confirm job snapshots", async () => {
    const previewSnapshot = {
      mode: "ids" as const,
      action: "setTags" as const,
      item_ids: ["cat_alpha", "cat_beta"],
      total: 2,
      ready_count: 2,
      blocked_count: 0,
      candidates: [
        {
          catalog_item_id: "cat_alpha",
          title: "Alpha",
          status: "active",
          blueprint_id: "bpr_pokemon_card",
          category_ids: ["ctg_pokemon"],
          tags: ["featured"],
          outcome: "ready",
          reason: null,
        },
        {
          catalog_item_id: "cat_beta",
          title: "Beta",
          status: "draft",
          blueprint_id: null,
          category_ids: [],
          tags: [],
          outcome: "ready",
          reason: null,
        },
      ],
    } satisfies BulkEditCatalogItemPreview;
    const previewBulkEdit = vi.fn(async () => previewSnapshot);
    const enqueue = vi.fn(createJobServices().enqueue);
    const app = buildApp(createServices({ previewBulkEdit }), createJobServices({ enqueue }));

    const previewResponse = await app.fetch(
      jsonRequest("/items/bulk-edit/preview", {
        operation: { action: "setTags", tags: ["featured"] },
        selection: { mode: "ids", ids: ["cat_alpha", "cat_beta"] },
      }),
    );
    const confirmResponse = await app.fetch(
      jsonRequest("/items/bulk-edit/confirm", {
        operation: { action: "setTags", tags: ["featured"] },
        selection: { mode: "ids", ids: ["cat_alpha", "cat_beta"] },
      }),
    );

    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toMatchObject({
      action: "setTags",
      item_ids: ["cat_alpha", "cat_beta"],
      total: 2,
      ready_count: 2,
    });
    expect(previewBulkEdit).toHaveBeenCalledWith(
      { mode: "ids", ids: ["cat_alpha", "cat_beta"] },
      { action: "setTags", tags: ["featured"] },
    );

    expect(confirmResponse.status).toBe(202);
    await expect(confirmResponse.json()).resolves.toMatchObject({
      jobId: "job_catalog_items",
      kind: "catalog.authoring.items.edit",
      action: "setTags",
      status: "queued",
    });
    expect(enqueue).toHaveBeenCalledWith({
      kind: "catalog.authoring.items.edit",
      action: "setTags",
      selection: { mode: "ids", ids: ["cat_alpha", "cat_beta"] },
      operation: { action: "setTags", tags: ["featured"] },
      context,
    });
  });
});
