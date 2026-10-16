import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { CatalogItemId } from "../../ids";
import { buildBlueprintProjectionHandlers } from "../../features/blueprints/read-model/projection";
import { refreshCatalogAdminBlueprintDetailPage } from "../../features/blueprints/read-model/admin-projection";
import { catalogBlueprintSchemaSql } from "../../features/blueprints/read-model/schema";
import { catalogCatalogItemSchemaSql } from "../../features/catalog-items/read-model/schema";
import { catalogComponentSchemaSql } from "../../features/components/read-model/schema";
import { catalogDimensionSchemaSql } from "../../features/dimensions/read-model/schema";
import { catalogFieldSchemaSql } from "../../features/fields/read-model/schema";
import { resolveCatalogProductSelection } from "./product-selection";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = adminDatabaseUrl ? describe : describe.skip;
const rules = [
  { dimensionId: "d1", required: true, allowedOptionIds: ["o1", "inactive"] },
  {
    dimensionId: "d2",
    required: false,
    allowedOptionIds: ["o2"],
    appliesWhen: [{ dimensionId: "d1", optionIds: ["o1"] }],
  },
];
const fullSelection = [
  { dimensionId: "d2", optionId: "o2" },
  { dimensionId: "d1", optionId: "o1" },
];

describeDb("Catalog Product selection against domain Blueprints", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["catalog"], "catalog_product_selection");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools!);
    const db = pools!.catalog;
    for (const schema of [
      catalogBlueprintSchemaSql,
      catalogCatalogItemSchemaSql,
      catalogComponentSchemaSql,
      catalogDimensionSchemaSql,
      catalogFieldSchemaSql,
    ]) {
      await db.query(schema);
    }
    const handlers = buildBlueprintProjectionHandlers(db);
    for (const [type, data] of [
      ["created", { blueprintId: "blueprint", key: "blueprint", name: "Blueprint" }],
      ["dimensions-set", { dimensionRules: rules }],
      ["product-resolution-rules-set", { canonicalDimensionOrder: ["d1", "d2"] }],
      ["published", {}],
    ] as const) {
      await handlers[`catalog.blueprint.${type}`]!({
        type: `catalog.blueprint.${type}`,
        streamId: "catalog.blueprint-blueprint",
        data,
        timing: { recordedAt: "2026-10-15T00:00:00.000Z" },
      } as never);
    }
    await refreshCatalogAdminBlueprintDetailPage(db, "blueprint");
    await db.query(
      "INSERT INTO catalog_items (catalog_item_id, blueprint_id, status) VALUES ('item', 'blueprint', 'active')",
    );
    await db.query(
      "INSERT INTO catalog_admin_catalog_item_detail_pages (catalog_item_id, blueprint_id, status) VALUES ('item', 'blueprint', 'active')",
    );
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function resolve(selectedOptions: readonly { dimensionId: string; optionId: string }[] = [], itemId = "item") {
    return resolveCatalogProductSelection(pools!.catalog, {
      catalogItemId: itemId as CatalogItemId,
      productId: "ignored-input-key" as ProductKey,
      selectedOptions,
    });
  }

  it.each([
    ["full selection", fullSelection, "item::d1:o1|d2:o2", [fullSelection[1], fullSelection[0]]],
    ["optional dimension unset", [fullSelection[1]], "item::d1:o1|d2:-", [fullSelection[1]]],
  ])(
    "resolves %s using the domain row despite a real named admin projection",
    async (_label, selection, productId, selectedOptions) => {
      const admin = await pools!.catalog.query<{ dimension_rules: unknown; canonical_dimension_order: unknown }>(
        "SELECT dimension_rules, canonical_dimension_order FROM catalog_admin_blueprint_detail_pages WHERE blueprint_id = 'blueprint'",
      );
      expect(admin.rows[0]?.dimension_rules).toMatchObject([
        { allowedOptions: [{ optionId: "o1" }, { optionId: "inactive" }] },
        { allowedOptions: [{ optionId: "o2" }] },
      ]);
      expect(admin.rows[0]?.canonical_dimension_order).toEqual([
        { dimensionId: "d1", dimensionName: "d1" },
        { dimensionId: "d2", dimensionName: "d2" },
      ]);
      expect(await resolve(selection)).toEqual({
        availability: "active",
        product: { catalogItemId: "item", productId, selectedOptions },
      });
    },
  );

  it.each([
    ["disallowed Option", [{ dimensionId: "d1", optionId: "outside" }]],
    ["missing required dimension", []],
    ["unknown dimension", [...fullSelection, { dimensionId: "unknown", optionId: "o3" }]],
    [
      "inactive appliesWhen dimension",
      [
        { dimensionId: "d1", optionId: "inactive" },
        { dimensionId: "d2", optionId: "o2" },
      ],
    ],
  ])("rejects %s as an invalid selection", async (_label, selection) => {
    expect(await resolve(selection)).toEqual({ availability: "active", product: null });
  });

  it("returns unavailable for admin-shaped JSON stored in the domain row", async () => {
    await pools!.catalog.query(`UPDATE catalog_blueprints SET
      dimension_rules = admin.dimension_rules, canonical_dimension_order = admin.canonical_dimension_order
      FROM catalog_admin_blueprint_detail_pages AS admin WHERE catalog_blueprints.blueprint_id = admin.blueprint_id`);
    expect(await resolve(fullSelection)).toEqual({ availability: "unavailable", product: null });
  });

  it("resolves a dimensionless Blueprint", async () => {
    await pools!.catalog.query(
      "UPDATE catalog_blueprints SET dimension_rules = '[]', canonical_dimension_order = '[]'",
    );
    await refreshCatalogAdminBlueprintDetailPage(pools!.catalog, "blueprint");
    expect(await resolve()).toEqual({
      availability: "active",
      product: { catalogItemId: "item", productId: "item::", selectedOptions: [] },
    });
  });

  it("resolves a Blueprint-less item", async () => {
    await pools!.catalog.query("UPDATE catalog_admin_catalog_item_detail_pages SET blueprint_id = NULL");
    expect(await resolve()).toEqual({
      availability: "active",
      product: { catalogItemId: "item", productId: "item::", selectedOptions: [] },
    });
  });

  it("returns missing for an unknown item", async () => {
    expect(await resolve([], "missing")).toEqual({ availability: "missing", product: null });
  });

  it("returns retired for an archived item", async () => {
    await pools!.catalog.query("UPDATE catalog_admin_catalog_item_detail_pages SET status = 'archived'");
    expect(await resolve()).toEqual({ availability: "retired", product: null });
  });
});
