import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import { productContentRoutes } from "./route";
import type { ProductContentServices } from "./runtime";
import { createProductContentRuntime } from "./runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

function buildApp(services: ProductContentServices) {
  const app = new Hono<CatalogAuthoringEnv>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("context", context);
    await next();
  });
  app.route("/product-contents", productContentRoutes(services));
  return app;
}

function createServices(overrides: Partial<ProductContentServices> = {}): ProductContentServices {
  return {
    upsertContentType: async () => undefined,
    upsertInclusionPolicy: async () => undefined,
    replaceProductContents: async (input) => ({
      containerCatalogItemId: input.containerCatalogItemId,
      containerSelectedOptions: input.containerSelectedOptions ?? null,
      containerProductId: null,
      lines: [],
      resolvedFactHash: "hash",
      resolverVersion: 1,
      resolvedAt: "2026-07-01T00:00:00.000Z",
      version: 0,
    }),
    removeProductContents: async (input) => ({
      containerCatalogItemId: input.containerCatalogItemId,
      containerSelectedOptions: input.containerSelectedOptions ?? null,
      containerProductId: null,
      lines: [],
      resolvedFactHash: "hash",
      resolverVersion: 1,
      resolvedAt: "2026-07-01T00:00:00.000Z",
      version: 0,
    }),
    listProductContentTypes: async () => [],
    listProductContentInclusionPolicies: async () => [],
    listProductContentsForContainer: async () => [],
    listProductContainersForContained: async () => [],
    readProductContentsAuthoringState: async (containerCatalogItemId) => ({
      containerCatalogItemId,
      containerSelectedOptions: null,
      lines: [],
      version: 0,
    }),
    projectors: [],
    ...overrides,
  };
}

describe("product content routes", () => {
  it("maps stale expectedVersion to 409 and rejects missing or wildcard versions", async () => {
    const store = createInMemoryEventStore();
    const queryCalls = vi.fn((_sql: string, _params?: readonly unknown[]) => undefined);
    const query = async <T>(sql: string, params?: readonly unknown[]) => {
      queryCalls(sql, params);
      if (sql.includes("FROM catalog_items"))
        return {
          rows: [
            {
              catalog_item_id: params?.[0],
              status: "active",
              blueprint_id: "bp_plain",
              dimension_rules: [],
              canonical_dimension_order: [],
            },
          ] as T[],
        };
      if (sql.includes("FROM catalog_product_content_types"))
        return {
          rows: [
            {
              content_type_id: "pct_card",
              key: "card",
              display_name: { defaultLocale: "en", values: { en: "Card" } },
              status: "active",
              sort_order: 10,
              discovery_search_weight: null,
            },
          ] as T[],
        };
      return { rows: [] as T[] };
    };
    const services = createProductContentRuntime({
      db: { query },
      eventStore: store.eventStore,
      checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
    });
    const replace = vi.spyOn(services, "replaceProductContents");
    const remove = vi.spyOn(services, "removeProductContents");
    const app = buildApp(services);
    const lines = [{ containedCatalogItemId: "cat_card", quantity: 1, contentTypeId: "pct_card" }];
    const request = (method: string, body: object) =>
      app.fetch(
        new Request("http://catalog.test/product-contents/containers/cat_box", { method, body: JSON.stringify(body) }),
      );
    const snapshot = await (
      await app.fetch(new Request("http://catalog.test/product-contents/containers/cat_box/authoring"))
    ).json();
    expect(snapshot).toMatchObject({ lines: [], version: 0 });
    expect((await request("PUT", { lines, expectedVersion: 0 })).status).toBe(200);
    const committedEvents = store.readAllEvents();
    for (const staleLines of [[{ ...lines[0]!, quantity: 2 }], lines, []]) {
      queryCalls.mockClear();
      expect((await request("PUT", { lines: staleLines, expectedVersion: 0 })).status).toBe(409);
      expect(
        queryCalls.mock.calls.some(([sql]) =>
          /(?:INSERT INTO|DELETE FROM) catalog_resolved_product_contents/.test(sql),
        ),
      ).toBe(false);
      expect(store.readAllEvents()).toEqual(committedEvents);
    }
    queryCalls.mockClear();
    expect((await request("DELETE", { expectedVersion: 0 })).status).toBe(409);
    expect(
      queryCalls.mock.calls.some(([sql]) => /(?:INSERT INTO|DELETE FROM) catalog_resolved_product_contents/.test(sql)),
    ).toBe(false);
    expect(store.readAllEvents()).toEqual(committedEvents);
    replace.mockClear();
    remove.mockClear();
    for (const method of ["PUT", "DELETE"]) {
      for (const expectedVersion of [undefined, "any", "*", -1, 1.5, null, Number.MAX_SAFE_INTEGER + 1]) {
        expect((await request(method, { lines, expectedVersion })).status).toBe(400);
      }
    }
    expect(replace).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(store.readAllEvents()).toEqual(committedEvents);
    const fresh = await request("PUT", { lines, expectedVersion: 2 });
    expect(fresh.status).toBe(200);
    await expect(fresh.json()).resolves.toMatchObject({ version: 2 });
    expect(store.readAllEvents()).toEqual(committedEvents);
  });

  it("lists configured content types and inclusion policies", async () => {
    const app = buildApp(
      createServices({
        listProductContentTypes: async () => [
          {
            content_type_id: "pct_pack",
            key: "pack",
            display_name: { defaultLocale: "en", values: { en: "Pack" } },
            status: "active",
            sort_order: 10,
            discovery_search_weight: 0.2,
            updated_at: "2026-07-01T00:00:00.000Z",
          },
        ],
        listProductContentInclusionPolicies: async () => [
          {
            inclusion_policy_id: "pcp_guaranteed",
            key: "guaranteed",
            display_name: { defaultLocale: "en", values: { en: "Guaranteed" } },
            status: "active",
            sort_order: 10,
            updated_at: "2026-07-01T00:00:00.000Z",
          },
        ],
      }),
    );

    const contentTypesResponse = await app.fetch(new Request("http://catalog.test/product-contents/content-types"));
    const policiesResponse = await app.fetch(new Request("http://catalog.test/product-contents/inclusion-policies"));

    await expect(contentTypesResponse.json()).resolves.toMatchObject({
      total: 1,
      items: [{ content_type_id: "pct_pack" }],
    });
    await expect(policiesResponse.json()).resolves.toMatchObject({
      total: 1,
      items: [{ inclusion_policy_id: "pcp_guaranteed" }],
    });
  });

  it("replaces container contents with selected target lines", async () => {
    const replaceProductContents = vi.fn(createServices().replaceProductContents);
    const app = buildApp(createServices({ replaceProductContents }));

    const response = await app.fetch(
      new Request("http://catalog.test/product-contents/containers/cat_box", {
        method: "PUT",
        body: JSON.stringify({
          containerSelectedOptions: [{ dimensionId: "language", optionId: "en" }],
          expectedVersion: 0,
          lines: [
            {
              containedCatalogItemId: "cat_pack",
              containedSelectedOptions: [{ dimensionId: "finish", optionId: "foil" }],
              quantity: 36,
              contentTypeId: "pct_pack",
              inclusionPolicyId: "pcp_guaranteed",
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(replaceProductContents).toHaveBeenCalledWith(
      {
        containerCatalogItemId: "cat_box",
        containerSelectedOptions: [{ dimensionId: "language", optionId: "en" }],
        expectedVersion: 0,
        lines: [
          {
            containedCatalogItemId: "cat_pack",
            containedSelectedOptions: [{ dimensionId: "finish", optionId: "foil" }],
            quantity: 36,
            contentTypeId: "pct_pack",
            inclusionPolicyId: "pcp_guaranteed",
            provenance: {},
          },
        ],
      },
      context,
    );
  });

  it("lists reverse containers for a contained Catalog Item", async () => {
    const listProductContainersForContained = vi.fn(async () => []);
    const app = buildApp(createServices({ listProductContainersForContained }));

    const response = await app.fetch(new Request("http://catalog.test/product-contents/contained/cat_pack"));

    expect(response.status).toBe(200);
    expect(listProductContainersForContained).toHaveBeenCalledWith("cat_pack");
  });
});
