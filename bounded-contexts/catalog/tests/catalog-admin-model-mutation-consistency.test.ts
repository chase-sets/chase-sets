import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { blueprintRoutes } from "../features/blueprints/api/route";
import type { BlueprintServices } from "../features/blueprints/api/runtime";
import { categoryRoutes } from "../features/categories/api/route";
import type { CategoryServices } from "../features/categories/api/runtime";
import { componentRoutes } from "../features/components/api/route";
import type { ComponentServices } from "../features/components/api/runtime";
import { dimensionRoutes } from "../features/dimensions/api/route";
import type { DimensionServices } from "../features/dimensions/api/runtime";
import { displayTemplateRoutes } from "../features/display-templates/api/route";
import type { DisplayTemplateServices } from "../features/display-templates/api/runtime";
import { fieldRoutes } from "../features/fields/api/route";
import type { FieldServices } from "../features/fields/api/runtime";
import { referenceDataRoutes } from "../features/reference-data/api/route";
import type { ReferenceDataServices } from "../features/reference-data/api/runtime";
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
    en: "Admin model",
  },
};

function buildApp(mount: (app: Hono<CatalogAuthoringEnv>) => void) {
  const app = new Hono<CatalogAuthoringEnv>();
  app.use("*", async (c, next) => {
    c.set("context", context);
    await next();
  });
  mount(app);
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
      jobId: "job_catalog_admin",
      kind: input.kind,
      action: input.action,
      status: "queued",
      progress: { phase: "queued", completed: 0, total: 3, currentName: null, status: "queued" },
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

function createBulkLifecycle() {
  return {
    preview: vi.fn(async () => ({
      mode: "ids" as const,
      action: "archive",
      ids: ["cat_alpha", "cat_beta"],
      total: 2,
      ready_count: 1,
      blocked_count: 1,
      candidates: [
        { id: "cat_alpha", label: "Alpha", status: "deprecated", outcome: "ready", reason: null },
        { id: "cat_beta", label: "Beta", status: "active", outcome: "blocked", reason: "not deprecated" },
      ],
    })),
    execute: vi.fn(),
  };
}

describe("catalog admin model mutation consistency", () => {
  it("returns a committed Blueprint command snapshot without reading a stale projection detail", async () => {
    const getBlueprintDetail = vi.fn(async () => ({
      blueprint_id: "bpr_card",
      status: "draft",
      component_ids: [],
    }));
    const commandHandler = vi.fn(async () =>
      commandResult(
        {
          id: "bpr_card",
          key: "pokemon-card",
          name: englishName,
          description: englishName,
          status: "active",
          componentIds: ["cmp_identity"],
          fieldRules: [{ fieldId: "fld_card_name", required: true }],
          dimensionRules: [],
          canonicalDimensionOrder: [],
        },
        7,
      ),
    );
    const app = buildApp((app) =>
      app.route(
        "/blueprints",
        blueprintRoutes(
          {
            commandHandler,
            listBlueprints: async () => ({ items: [], total: 0 }),
            getBlueprintDetail,
            bulkLifecycle: createBulkLifecycle(),
            projectors: [],
          } as unknown as BlueprintServices,
          createJobServices(),
        ),
      ),
    );

    const response = await app.fetch(
      jsonRequest(
        "/blueprints/bpr_card",
        {
          key: "pokemon-card",
          name: englishName,
          description: englishName,
        },
        "PUT",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "bpr_card",
      version: 7,
      status: "active",
      snapshot: {
        id: "bpr_card",
        status: "active",
        componentIds: ["cmp_identity"],
        fieldRules: [{ fieldId: "fld_card_name", required: true }],
      },
    });
    expect(getBlueprintDetail).not.toHaveBeenCalled();
  });

  it("returns Category bulk preview snapshots and enqueues confirm jobs with the request context", async () => {
    const bulkLifecycle = createBulkLifecycle();
    const enqueue = vi.fn(createJobServices().enqueue);
    const app = buildApp((app) =>
      app.route(
        "/categories",
        categoryRoutes(
          {
            commandHandler: vi.fn(),
            listCategories: async () => ({ items: [], total: 0 }),
            getCategoryDetail: async () => null,
            bulkLifecycle,
            projectors: [],
          } as unknown as CategoryServices,
          createJobServices({ enqueue }),
        ),
      ),
    );

    const previewResponse = await app.fetch(
      jsonRequest("/categories/bulk-lifecycle/preview", {
        action: "archive",
        selection: { mode: "ids", ids: ["cat_alpha", "cat_beta"] },
      }),
    );
    const confirmResponse = await app.fetch(
      jsonRequest("/categories/bulk-lifecycle/confirm", {
        action: "archive",
        selection: { mode: "ids", ids: ["cat_alpha"] },
      }),
    );

    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toMatchObject({
      action: "archive",
      ids: ["cat_alpha", "cat_beta"],
      ready_count: 1,
      blocked_count: 1,
    });
    expect(bulkLifecycle.preview).toHaveBeenCalledWith({ mode: "ids", ids: ["cat_alpha", "cat_beta"] }, "archive");

    expect(confirmResponse.status).toBe(202);
    await expect(confirmResponse.json()).resolves.toMatchObject({
      jobId: "job_catalog_admin",
      kind: "catalog.authoring.categories.lifecycle",
      action: "archive",
      status: "queued",
    });
    expect(enqueue).toHaveBeenCalledWith({
      kind: "catalog.authoring.categories.lifecycle",
      action: "archive",
      selection: { mode: "ids", ids: ["cat_alpha"] },
      context,
    });
  });

  it("returns Component rule snapshots after relationship mutations", async () => {
    const commandHandler = vi.fn(async () =>
      commandResult({
        id: "cmp_identity",
        key: "identity",
        name: englishName,
        description: englishName,
        status: "draft",
        fieldRules: [{ fieldId: "fld_card_name", required: true }],
        dimensionRules: [],
      }),
    );
    const app = buildApp((app) =>
      app.route(
        "/components",
        componentRoutes(
          {
            commandHandler,
            listComponents: async () => ({ items: [], total: 0 }),
            getComponentDetail: async () => null,
            bulkLifecycle: createBulkLifecycle(),
            projectors: [],
          } as unknown as ComponentServices,
          createJobServices(),
        ),
      ),
    );

    const response = await app.fetch(
      jsonRequest("/components/cmp_identity/field-rules", { fieldId: "fld_card_name", required: true }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: "cmp_identity",
      snapshot: {
        id: "cmp_identity",
        fieldRules: [{ fieldId: "fld_card_name", required: true }],
      },
    });
  });

  it("returns Dimension option snapshots for option lifecycle commands", async () => {
    const commandHandler = vi.fn(async () =>
      commandResult(
        {
          id: "dim_finish",
          key: "finish",
          name: englishName,
          description: englishName,
          valueKind: "unordered",
          status: "active",
          options: [
            {
              id: "chc_foil",
              code: "foil",
              label: englishName,
              displayOrder: 0,
              numericValue: null,
              status: "deprecated",
            },
          ],
        },
        5,
      ),
    );
    const app = buildApp((app) =>
      app.route(
        "/dimensions",
        dimensionRoutes(
          {
            commandHandler,
            listDimensions: async () => ({ items: [], total: 0 }),
            getDimension: async () => null,
            bulkLifecycle: createBulkLifecycle(),
            projectors: [],
          } as unknown as DimensionServices,
          createJobServices(),
        ),
      ),
    );

    const response = await app.fetch(jsonRequest("/dimensions/dim_finish/options/chc_foil/deprecate", {}, "POST"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "dim_finish",
      version: 5,
      snapshot: {
        id: "dim_finish",
        options: [{ id: "chc_foil", status: "deprecated" }],
      },
    });
  });

  it("returns Display Template lifecycle snapshots", async () => {
    const commandHandler = vi.fn(async () =>
      commandResult({
        id: "dtp_global",
        key: "global-title",
        name: englishName,
        description: englishName,
        target: { kind: "global" },
        priority: 0,
        titleTemplate: "{item.name}",
        subtitleTemplate: null,
        requiredFieldKeys: [],
        status: "active",
      }),
    );
    const app = buildApp((app) =>
      app.route(
        "/display-templates",
        displayTemplateRoutes({
          commandHandler,
          listDisplayTemplates: async () => ({ items: [], total: 0 }),
          getDisplayTemplateDetail: async () => null,
          projectors: [],
        } as unknown as DisplayTemplateServices),
      ),
    );

    const response = await app.fetch(jsonRequest("/display-templates/dtp_global/publish", {}, "POST"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "dtp_global",
      status: "active",
      snapshot: { id: "dtp_global", status: "active", titleTemplate: "{item.name}" },
    });
  });

  it("returns Field lifecycle snapshots", async () => {
    const commandHandler = vi.fn(async () =>
      commandResult({
        id: "fld_card_name",
        key: "card-name",
        name: englishName,
        description: englishName,
        status: "archived",
        valueType: "string",
        behavior: { filterable: true, searchable: true, sortable: false },
      }),
    );
    const app = buildApp((app) =>
      app.route(
        "/fields",
        fieldRoutes(
          {
            commandHandler,
            listFields: async () => ({ items: [], total: 0 }),
            getField: async () => null,
            bulkLifecycle: createBulkLifecycle(),
            projectors: [],
          } as unknown as FieldServices,
          createJobServices(),
        ),
      ),
    );

    const response = await app.fetch(jsonRequest("/fields/fld_card_name/archive", {}, "POST"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "fld_card_name",
      status: "archived",
      snapshot: { id: "fld_card_name", status: "archived", valueType: "string" },
    });
  });

  it("returns Reference Type and Reference Record snapshots from their command owners", async () => {
    const referenceTypeCommandHandler = vi.fn(async () =>
      commandResult({
        id: "rft_expansion",
        key: "expansion",
        name: englishName,
        description: englishName,
        status: "active",
        attributeKeys: ["release-date"],
      }),
    );
    const referenceRecordCommandHandler = vi.fn(async () =>
      commandResult({
        id: "ref_ascended_heroes",
        typeKey: "expansion",
        key: "ascended-heroes",
        name: englishName,
        description: englishName,
        attributes: { "release-date": "2026-06-15" },
        relationships: [{ relationshipType: "series", referenceId: "ref_mega-evolution" }],
        status: "draft",
      }),
    );
    const app = buildApp((app) =>
      app.route(
        "/",
        referenceDataRoutes(
          {
            referenceTypeCommandHandler,
            referenceRecordCommandHandler,
            listReferenceTypes: async () => ({ items: [], total: 0 }),
            listReferenceRecords: async () => ({ items: [], total: 0 }),
            getReferenceType: async () => null,
            getReferenceRecord: async () => null,
            referenceTypeBulkLifecycle: createBulkLifecycle(),
            referenceRecordBulkLifecycle: createBulkLifecycle(),
            projectors: [],
          } as unknown as ReferenceDataServices,
          createJobServices(),
        ),
      ),
    );

    const typeResponse = await app.fetch(jsonRequest("/reference-types/rft_expansion/publish", {}, "POST"));
    const recordResponse = await app.fetch(
      jsonRequest(
        "/reference-records/ref_ascended_heroes",
        {
          typeKey: "expansion",
          key: "ascended-heroes",
          name: englishName,
          attributes: { "release-date": "2026-06-15" },
          relationships: [{ relationshipType: "series", referenceId: "ref_mega-evolution" }],
        },
        "PUT",
      ),
    );

    expect(typeResponse.status).toBe(200);
    await expect(typeResponse.json()).resolves.toMatchObject({
      id: "rft_expansion",
      status: "active",
      snapshot: { id: "rft_expansion", status: "active", attributeKeys: ["release-date"] },
    });

    expect(recordResponse.status).toBe(200);
    await expect(recordResponse.json()).resolves.toMatchObject({
      id: "ref_ascended_heroes",
      status: "draft",
      snapshot: {
        id: "ref_ascended_heroes",
        attributes: { "release-date": "2026-06-15" },
        relationships: [{ relationshipType: "series", referenceId: "ref_mega-evolution" }],
      },
    });
  });
});
