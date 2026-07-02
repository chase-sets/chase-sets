import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { productContentRoutes } from "./route";
import type { ProductContentServices } from "./runtime";
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
    }),
    removeProductContents: async (input) => ({
      containerCatalogItemId: input.containerCatalogItemId,
      containerSelectedOptions: input.containerSelectedOptions ?? null,
      containerProductId: null,
      lines: [],
      resolvedFactHash: "hash",
      resolverVersion: 1,
      resolvedAt: "2026-07-01T00:00:00.000Z",
    }),
    listProductContentTypes: async () => [],
    listProductContentInclusionPolicies: async () => [],
    listProductContentsForContainer: async () => [],
    listProductContainersForContained: async () => [],
    projectors: [],
    ...overrides,
  };
}

describe("product content routes", () => {
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
