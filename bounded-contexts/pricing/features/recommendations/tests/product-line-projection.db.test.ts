import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { buildPricingCatalogInputProjectionHandlers } from "../integrations/source/source-projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

let nextVersion = 0;
function event(type: string, streamId: string, data: Record<string, unknown>) {
  nextVersion += 1;
  return {
    type,
    streamId,
    streamVersion: nextVersion,
    data,
    timing: { recordedAt: `2026-10-16T00:00:${String(nextVersion).padStart(2, "0")}.000Z` },
  } as never;
}

describeDb("Catalog Product Line projection", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_product_line_projection");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).pricing;
  });
  beforeEach(async () => {
    nextVersion = 0;
    await resetMultiContextTestSchemas({ pricing: pool });
    await pool.query(pricingModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools({ pricing: pool }));

  it("projects direct, inherited and null Product Lines without category substitution", async () => {
    const handlers = buildPricingCatalogInputProjectionHandlers(pool);
    await handlers["catalog.catalog-item.created"]!(
      event("catalog.catalog-item.created", "catalog.item-cat_direct", { itemId: "cat_direct", title: "Direct" }),
    );
    await handlers["catalog.catalog-item.created"]!(
      event("catalog.catalog-item.created", "catalog.item-cat_inherited", {
        itemId: "cat_inherited",
        title: "Inherited",
      }),
    );
    await handlers["catalog.catalog-item.created"]!(
      event("catalog.catalog-item.created", "catalog.item-cat_null", { itemId: "cat_null", title: "Null" }),
    );
    await handlers["catalog.reference-record.created"]!(
      event("catalog.reference-record.created", "catalog.reference-record-ref_line", {
        referenceRecordId: "ref_line",
        typeKey: "product-line",
        name: "Pokemon",
        relationships: [],
      }),
    );
    await handlers["catalog.reference-record.created"]!(
      event("catalog.reference-record.created", "catalog.reference-record-ref_set", {
        referenceRecordId: "ref_set",
        typeKey: "set",
        name: "Base Set",
        relationships: [{ relationshipType: "part-of", referenceId: "ref_line" }],
      }),
    );
    await handlers["catalog.catalog-item.field-value-set"]!(
      event("catalog.catalog-item.field-value-set", "catalog.item-cat_direct", {
        fieldId: "fld_line",
        value: { referenceId: "ref_line" },
      }),
    );
    await handlers["catalog.catalog-item.field-value-set"]!(
      event("catalog.catalog-item.field-value-set", "catalog.item-cat_inherited", {
        fieldId: "fld_set",
        value: { referenceId: "ref_set" },
      }),
    );
    await handlers["catalog.catalog-item.category-assigned"]!(
      event("catalog.catalog-item.category-assigned", "catalog.item-cat_null", { categoryId: "ref_line" }),
    );

    await expect(
      pool.query(
        "SELECT product_line_reference_id, product_line_name FROM pricing_catalog_item_inputs ORDER BY catalog_item_id",
      ),
    ).resolves.toMatchObject({
      rows: [
        { product_line_reference_id: "ref_line", product_line_name: "Pokemon" },
        { product_line_reference_id: "ref_line", product_line_name: "Pokemon" },
        { product_line_reference_id: null, product_line_name: null },
      ],
    });
  });

  it("replays idempotently and updates changed hierarchy with the reference stream version", async () => {
    const handlers = buildPricingCatalogInputProjectionHandlers(pool);
    await handlers["catalog.catalog-item.created"]!(
      event("catalog.catalog-item.created", "catalog.item-cat_1", { itemId: "cat_1", title: "Item" }),
    );
    await handlers["catalog.reference-record.created"]!(
      event("catalog.reference-record.created", "catalog.reference-record-ref_a", {
        referenceRecordId: "ref_a",
        typeKey: "product-line",
        name: "A",
        relationships: [],
      }),
    );
    await handlers["catalog.reference-record.created"]!(
      event("catalog.reference-record.created", "catalog.reference-record-ref_b", {
        referenceRecordId: "ref_b",
        typeKey: "product-line",
        name: "B",
        relationships: [],
      }),
    );
    await handlers["catalog.reference-record.created"]!(
      event("catalog.reference-record.created", "catalog.reference-record-ref_set", {
        referenceRecordId: "ref_set",
        typeKey: "set",
        name: "Set",
        relationships: [{ relationshipType: "part-of", referenceId: "ref_a" }],
      }),
    );
    const setEvent = event("catalog.catalog-item.field-value-set", "catalog.item-cat_1", {
      fieldId: "fld_set",
      value: { referenceId: "ref_set" },
    });
    await handlers["catalog.catalog-item.field-value-set"]!(setEvent);
    await handlers["catalog.catalog-item.field-value-set"]!(setEvent);
    await handlers["catalog.reference-record.revised"]!(
      event("catalog.reference-record.revised", "catalog.reference-record-ref_set", {
        referenceRecordId: "ref_set",
        typeKey: "set",
        name: "Set",
        relationships: [{ relationshipType: "part-of", referenceId: "ref_b" }],
      }),
    );
    const result = await pool.query(
      "SELECT product_line_reference_id, product_line_name, product_line_version FROM pricing_catalog_item_inputs WHERE catalog_item_id = 'cat_1'",
    );
    expect(result.rows).toEqual([
      { product_line_reference_id: "ref_b", product_line_name: "B", product_line_version: expect.any(Number) },
    ]);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS count FROM pricing_catalog_reference_inputs WHERE catalog_item_id = 'cat_1'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
});
