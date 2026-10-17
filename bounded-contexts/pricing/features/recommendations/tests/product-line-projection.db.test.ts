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
import { readCatalogItemProductLineInputs } from "../read-model/catalog-product-line-inputs";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

const streamVersions = new Map<string, number>();
const recordedEvents: { type: string; payload: never }[] = [];
let nextRecordedAt = 0;
function event(type: string, streamId: string, data: Record<string, unknown>) {
  const streamVersion = (streamVersions.get(streamId) ?? 0) + 1;
  streamVersions.set(streamId, streamVersion);
  nextRecordedAt += 1;
  const payload = {
    type,
    streamId,
    streamVersion,
    data,
    timing: { recordedAt: new Date(Date.UTC(2026, 9, 16, 0, 0, nextRecordedAt)).toISOString() },
  } as never;
  recordedEvents.push({ type, payload });
  return payload;
}

describeDb("Catalog Product Line projection", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_product_line_projection");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).pricing;
  });
  beforeEach(async () => {
    streamVersions.clear();
    recordedEvents.length = 0;
    nextRecordedAt = 0;
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
    await expect(readCatalogItemProductLineInputs(pool, ["cat_direct", "cat_inherited", "cat_null"])).resolves.toEqual([
      { catalogItemId: "cat_direct", productLine: { referenceId: "ref_line", name: "Pokemon", version: 1 } },
      { catalogItemId: "cat_inherited", productLine: { referenceId: "ref_line", name: "Pokemon", version: 1 } },
      { catalogItemId: "cat_null", productLine: null },
    ]);
  });

  it("replays idempotently and versions only changes to the resolved Product Line tuple", async () => {
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
    const readVersion = async () =>
      (await pool.query("SELECT product_line_version FROM pricing_catalog_item_inputs WHERE catalog_item_id = 'cat_1'"))
        .rows[0]?.product_line_version;
    expect(await readVersion()).toBe(1);
    await handlers["catalog.catalog-item.field-value-set"]!(setEvent);
    expect(await readVersion()).toBe(1);
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
      { product_line_reference_id: "ref_b", product_line_name: "B", product_line_version: 2 },
    ]);
    await handlers["catalog.reference-record.revised"]!(
      event("catalog.reference-record.revised", "catalog.reference-record-ref_a", {
        typeKey: "product-line",
        name: "Unrelated A revision",
        relationships: [],
      }),
    );
    expect(await readVersion()).toBe(2);
    for (const { type, payload } of recordedEvents) await handlers[type]!(payload);
    expect(await readVersion()).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS count FROM pricing_catalog_reference_inputs WHERE catalog_item_id = 'cat_1'",
        )
      ).rows[0]?.count,
    ).toBe(1);
    const replayed = await pool.query(
      "SELECT product_line_reference_id, product_line_name, product_line_version FROM pricing_catalog_item_inputs ORDER BY catalog_item_id",
    );
    await resetMultiContextTestSchemas({ pricing: pool });
    await pool.query(pricingModule.schemaSql);
    for (const { type, payload } of recordedEvents) await handlers[type]!(payload);
    expect(
      (
        await pool.query(
          "SELECT product_line_reference_id, product_line_name, product_line_version FROM pricing_catalog_item_inputs ORDER BY catalog_item_id",
        )
      ).rows,
    ).toEqual(replayed.rows);
    await handlers["catalog.reference-record.revised"]!(
      event("catalog.reference-record.revised", "catalog.reference-record-ref_b", {
        typeKey: "product-line",
        name: "B renamed",
        relationships: [],
      }),
    );
    expect(await readVersion()).toBe(3);
  });

  it("fences stale clears and sets, clears non-reference values, and preserves lifecycle-independent identity", async () => {
    const handlers = buildPricingCatalogInputProjectionHandlers(pool);
    await handlers["catalog.catalog-item.created"]!(
      event("catalog.catalog-item.created", "catalog.item-cat_clear", { itemId: "cat_clear", title: "Clear" }),
    );
    await handlers["catalog.reference-record.created"]!(
      event("catalog.reference-record.created", "catalog.reference-record-line", {
        referenceRecordId: "line",
        typeKey: "product-line",
        name: "Line",
        relationships: [],
      }),
    );
    await handlers["catalog.reference-record.created"]!(
      event("catalog.reference-record.created", "catalog.reference-record-set", {
        referenceRecordId: "set",
        typeKey: "set",
        name: "Set",
        relationships: [{ relationshipType: "part-of", referenceId: "line" }],
      }),
    );
    const staleClear = event("catalog.catalog-item.field-value-cleared", "catalog.item-cat_clear", {
      fieldId: "field",
    });
    const directSet = event("catalog.catalog-item.field-value-set", "catalog.item-cat_clear", {
      fieldId: "field",
      value: { referenceId: "line" },
    });
    const read = async () =>
      (
        await pool.query(
          "SELECT product_line_reference_id, product_line_name, product_line_version FROM pricing_catalog_item_inputs WHERE catalog_item_id = 'cat_clear'",
        )
      ).rows[0];
    await handlers["catalog.catalog-item.field-value-set"]!(directSet);
    await handlers["catalog.catalog-item.field-value-cleared"]!(staleClear);
    expect(await read()).toEqual({
      product_line_reference_id: "line",
      product_line_name: "Line",
      product_line_version: 1,
    });
    const clear = event("catalog.catalog-item.field-value-cleared", "catalog.item-cat_clear", { fieldId: "field" });
    await handlers["catalog.catalog-item.field-value-cleared"]!(clear);
    expect(await read()).toEqual({ product_line_reference_id: null, product_line_name: null, product_line_version: 2 });
    await handlers["catalog.catalog-item.field-value-set"]!(directSet);
    expect(await read()).toEqual({ product_line_reference_id: null, product_line_name: null, product_line_version: 2 });
    await handlers["catalog.catalog-item.field-value-set"]!(
      event("catalog.catalog-item.field-value-set", "catalog.item-cat_clear", {
        fieldId: "field",
        value: { referenceId: "set" },
      }),
    );
    expect(await read()).toEqual({
      product_line_reference_id: "line",
      product_line_name: "Line",
      product_line_version: 3,
    });
    for (const lifecycle of ["published", "deprecated", "archived"]) {
      const type = `catalog.reference-record.${lifecycle}`;
      await handlers[type]!(event(type, "catalog.reference-record-line", {}));
      expect(await read()).toEqual({
        product_line_reference_id: "line",
        product_line_name: "Line",
        product_line_version: 3,
      });
    }
    await expect(
      pool.query("SELECT status FROM pricing_catalog_reference_records WHERE reference_id = 'line'"),
    ).resolves.toMatchObject({ rows: [{ status: "archived" }] });
    await handlers["catalog.catalog-item.field-value-set"]!(
      event("catalog.catalog-item.field-value-set", "catalog.item-cat_clear", {
        fieldId: "field",
        value: "not a reference",
      }),
    );
    expect(await read()).toEqual({ product_line_reference_id: null, product_line_name: null, product_line_version: 4 });
  });
});
