import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { Hono } from "hono";
import {
  buildDiscoveryApi,
  createDiscoveryServices,
  discoverySchemaSql,
  rebuildDiscoverySearchIndex,
} from "../..";
import {
  createCatalogServices,
  catalogAuthoringSchemaSql,
  type CatalogServices,
} from "@chase-sets/catalog";
import { composeSchemaSql } from "@chase-sets/bounded-context-runtime";
import {
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://catalog:catalog@localhost:5432/catalog";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

let pool: PgTransactionalPool;
let catalogServices: CatalogServices;
let discoveryServices: ReturnType<typeof createDiscoveryServices>;
let app: Hono;

function createPool(connectionString: string): PgTransactionalPool {
  return new pg.Pool({ connectionString }) as unknown as PgTransactionalPool;
}

async function recreateSchema() {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await pool.query(
    composeSchemaSql([
      { schemaSql: catalogAuthoringSchemaSql },
      { schemaSql: discoverySchemaSql },
    ]),
  );
}

async function drainProjectors() {
  let processed = 0;

  do {
    processed = 0;
    for (const projector of discoveryServices.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

async function sendCommand<Command>(
  handler: (input: { streamId: string; command: Command; context: EventStoreContext }) => Promise<unknown>,
  streamId: string,
  command: Command,
) {
  return handler({ streamId, command, context });
}

const itemSeed = {
  dimensionId: "dim_condition",
  choiceId: "chc_nm",
  fieldId: "fld_name",
  blueprintId: "bpr_card",
  categoryId: "cat_pokemon",
  itemId: "cat_charizard",
};

describe("marketplace search", () => {
  beforeAll(async () => {
    pool = createPool(databaseUrl);
    catalogServices = createCatalogServices(pool);
    discoveryServices = createDiscoveryServices(pool);
    app = new Hono();
    app.route("/api/marketplace", buildDiscoveryApi(discoveryServices));
  });

  beforeEach(async () => {
    await recreateSchema();
  });

  afterAll(async () => {
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("indexes catalog facts into discovery search and item detail slices", async () => {
    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${itemSeed.dimensionId}`, {
      type: "CreateDimension",
      dimensionId: itemSeed.dimensionId as never,
      key: "condition",
      name: "Condition",
      description: "Card condition",
    });

    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${itemSeed.dimensionId}`, {
      type: "AddChoice",
      choiceId: itemSeed.choiceId as never,
      code: "near-mint",
      labels: [{ locale: "en", value: "Near Mint" }],
      numericValue: null,
    });

    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${itemSeed.dimensionId}`, {
      type: "ActivateDimension",
    });

    await sendCommand(catalogServices.fields.commandHandler, `catalog.field-${itemSeed.fieldId}`, {
      type: "CreateField",
      fieldId: itemSeed.fieldId as never,
      key: "card-name",
      name: "Card Name",
      description: "The printed card name",
      valueType: "string",
      behavior: { filterable: true, searchable: true, sortable: true },
    });

    await sendCommand(catalogServices.fields.commandHandler, `catalog.field-${itemSeed.fieldId}`, {
      type: "ActivateField",
    });

    await sendCommand(catalogServices.categories.commandHandler, `catalog.category-${itemSeed.categoryId}`, {
      type: "CreateCategory",
      categoryId: itemSeed.categoryId as never,
      key: "pokemon",
      name: "Pokemon",
      description: "Pokemon cards",
      displayOrder: 0,
    });

    await sendCommand(catalogServices.categories.commandHandler, `catalog.category-${itemSeed.categoryId}`, {
      type: "PublishCategory",
    });

    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${itemSeed.blueprintId}`, {
      type: "CreateBlueprint",
      blueprintId: itemSeed.blueprintId as never,
      key: "card",
      name: "Pokemon Card",
      description: "A tradable card",
    });

    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${itemSeed.blueprintId}`, {
      type: "SetBlueprintFields",
      fieldRules: [{ fieldId: itemSeed.fieldId as never, required: true }],
    });

    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${itemSeed.blueprintId}`, {
      type: "SetBlueprintDimensions",
      dimensionRules: [{
        dimensionId: itemSeed.dimensionId as never,
        required: true,
        allowedChoiceIds: [itemSeed.choiceId as never],
      }],
    });

    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${itemSeed.blueprintId}`, {
      type: "SetBlueprintVersionRules",
      canonicalDimensionOrder: [itemSeed.dimensionId as never],
    });

    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${itemSeed.blueprintId}`, {
      type: "PublishBlueprint",
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "CreateItem",
      itemId: itemSeed.itemId as never,
      title: "Charizard",
      subtitle: "Base Set",
      description: "Classic fire-breathing favorite",
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "AssignBlueprintToItem",
      blueprintId: itemSeed.blueprintId as never,
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "SetItemFieldValue",
      fieldId: itemSeed.fieldId as never,
      value: "Charizard",
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "AssignItemToCategory",
      categoryId: itemSeed.categoryId as never,
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "SetItemTags",
      tags: ["fire", "vintage"],
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "SetItemImageUrls",
      imageUrls: ["https://images.example/charizard.png"],
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "PublishItem",
      blueprintIsActive: true,
      requiredFieldIds: [itemSeed.fieldId as never],
    });

    await drainProjectors();

    const searchResponse = await app.request("/api/marketplace/items?search=charizard");
    expect(searchResponse.status).toBe(200);
    const searchBody = await searchResponse.json();
    expect(searchBody.total).toBe(1);
    expect(searchBody.items[0].title).toBe("Charizard");

    const detailResponse = await app.request(`/api/marketplace/items/${itemSeed.itemId}`);
    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json();
    expect(detailBody.title).toBe("Charizard");
    expect(detailBody.blueprint.name).toBe("Pokemon Card");
    expect(detailBody.categories[0].name).toBe("Pokemon");

    const categoryResponse = await app.request("/api/marketplace/categories");
    expect(categoryResponse.status).toBe(200);
    const categoryBody = await categoryResponse.json();
    expect(categoryBody.items[0].item_count).toBe(1);
  });

  it("projects conditional version rules and sealed products into item detail payloads", async () => {
    const ids = {
      categoryId: "cat_pokemon",
      formDimensionId: "dim_form",
      formRawChoiceId: "chc_form_raw",
      conditionDimensionId: "dim_condition",
      conditionChoiceId: "chc_condition_nm",
      cardBlueprintId: "bpr_card_single",
      sealedBlueprintId: "bpr_sealed",
      nameFieldId: "fld_name",
      setFieldId: "fld_set",
      packCountFieldId: "fld_pack_count",
      cardItemId: "cat_charizard",
      sealedItemId: "cat_etb",
    };

    await sendCommand(catalogServices.categories.commandHandler, `catalog.category-${ids.categoryId}`, {
      type: "CreateCategory",
      categoryId: ids.categoryId as never,
      key: "pokemon",
      name: "Pokemon",
      description: "Pokemon items",
      displayOrder: 0,
    });
    await sendCommand(catalogServices.categories.commandHandler, `catalog.category-${ids.categoryId}`, {
      type: "PublishCategory",
    });

    for (const field of [
      { fieldId: ids.nameFieldId, key: "card-name", name: "Card Name", valueType: "string" as const },
      { fieldId: ids.setFieldId, key: "set-name", name: "Set Name", valueType: "string" as const },
      { fieldId: ids.packCountFieldId, key: "pack-count", name: "Pack Count", valueType: "number" as const },
    ]) {
      await sendCommand(catalogServices.fields.commandHandler, `catalog.field-${field.fieldId}`, {
        type: "CreateField",
        fieldId: field.fieldId as never,
        key: field.key,
        name: field.name,
        description: field.name,
        valueType: field.valueType,
        behavior: { filterable: true, searchable: true, sortable: true },
      });
      await sendCommand(catalogServices.fields.commandHandler, `catalog.field-${field.fieldId}`, {
        type: "ActivateField",
      });
    }

    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${ids.formDimensionId}`, {
      type: "CreateDimension",
      dimensionId: ids.formDimensionId as never,
      key: "form",
      name: "Form",
      description: "Card form",
    });
    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${ids.formDimensionId}`, {
      type: "AddChoice",
      choiceId: ids.formRawChoiceId as never,
      code: "raw",
      labels: [{ locale: "en", value: "Raw" }],
      numericValue: null,
    });
    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${ids.formDimensionId}`, {
      type: "ActivateDimension",
    });

    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${ids.conditionDimensionId}`, {
      type: "CreateDimension",
      dimensionId: ids.conditionDimensionId as never,
      key: "condition",
      name: "Condition",
      description: "Card condition",
    });
    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${ids.conditionDimensionId}`, {
      type: "AddChoice",
      choiceId: ids.conditionChoiceId as never,
      code: "near-mint",
      labels: [{ locale: "en", value: "Near Mint" }],
      numericValue: null,
    });
    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${ids.conditionDimensionId}`, {
      type: "ActivateDimension",
    });

    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.cardBlueprintId}`, {
      type: "CreateBlueprint",
      blueprintId: ids.cardBlueprintId as never,
      key: "pokemon-card-single",
      name: "Pokemon Card Single",
      description: "Single card blueprint",
    });
    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.cardBlueprintId}`, {
      type: "SetBlueprintFields",
      fieldRules: [
        { fieldId: ids.nameFieldId as never, required: true },
        { fieldId: ids.setFieldId as never, required: true },
      ],
    });
    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.cardBlueprintId}`, {
      type: "SetBlueprintDimensions",
      dimensionRules: [
        { dimensionId: ids.formDimensionId as never, required: true, allowedChoiceIds: [ids.formRawChoiceId as never] },
        {
          dimensionId: ids.conditionDimensionId as never,
          required: true,
          allowedChoiceIds: [ids.conditionChoiceId as never],
          appliesWhen: [{ dimensionId: ids.formDimensionId as never, choiceIds: [ids.formRawChoiceId as never] }],
        },
      ],
    });
    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.cardBlueprintId}`, {
      type: "SetBlueprintVersionRules",
      canonicalDimensionOrder: [ids.formDimensionId as never, ids.conditionDimensionId as never],
    });
    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.cardBlueprintId}`, {
      type: "PublishBlueprint",
    });

    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.sealedBlueprintId}`, {
      type: "CreateBlueprint",
      blueprintId: ids.sealedBlueprintId as never,
      key: "pokemon-sealed-product",
      name: "Pokemon Sealed Product",
      description: "Sealed product blueprint",
    });
    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.sealedBlueprintId}`, {
      type: "SetBlueprintFields",
      fieldRules: [
        { fieldId: ids.setFieldId as never, required: true },
        { fieldId: ids.packCountFieldId as never, required: true },
      ],
    });
    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.sealedBlueprintId}`, {
      type: "SetBlueprintDimensions",
      dimensionRules: [],
    });
    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.sealedBlueprintId}`, {
      type: "SetBlueprintVersionRules",
      canonicalDimensionOrder: [],
    });
    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.sealedBlueprintId}`, {
      type: "PublishBlueprint",
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.cardItemId}`, {
      type: "CreateItem",
      itemId: ids.cardItemId as never,
      title: "Charizard",
      subtitle: "Base Set 4/102",
      description: "Classic single",
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.cardItemId}`, {
      type: "AssignBlueprintToItem",
      blueprintId: ids.cardBlueprintId as never,
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.cardItemId}`, {
      type: "SetItemFieldValue",
      fieldId: ids.nameFieldId as never,
      value: "Charizard",
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.cardItemId}`, {
      type: "SetItemFieldValue",
      fieldId: ids.setFieldId as never,
      value: "Base Set",
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.cardItemId}`, {
      type: "AssignItemToCategory",
      categoryId: ids.categoryId as never,
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.cardItemId}`, {
      type: "PublishItem",
      blueprintIsActive: true,
      requiredFieldIds: [ids.nameFieldId as never, ids.setFieldId as never],
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.sealedItemId}`, {
      type: "CreateItem",
      itemId: ids.sealedItemId as never,
      title: "Twilight Masquerade ETB",
      subtitle: "Sealed product",
      description: "Sealed product",
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.sealedItemId}`, {
      type: "AssignBlueprintToItem",
      blueprintId: ids.sealedBlueprintId as never,
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.sealedItemId}`, {
      type: "SetItemFieldValue",
      fieldId: ids.setFieldId as never,
      value: "Twilight Masquerade",
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.sealedItemId}`, {
      type: "SetItemFieldValue",
      fieldId: ids.packCountFieldId as never,
      value: 9,
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.sealedItemId}`, {
      type: "AssignItemToCategory",
      categoryId: ids.categoryId as never,
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.sealedItemId}`, {
      type: "PublishItem",
      blueprintIsActive: true,
      requiredFieldIds: [ids.setFieldId as never, ids.packCountFieldId as never],
    });

    await drainProjectors();

    const cardResponse = await app.request(`/api/marketplace/items/${ids.cardItemId}`);
    expect(cardResponse.status).toBe(200);
    const cardBody = await cardResponse.json();
    expect(
      cardBody.version_schema.dimensions.find((dimension: { dimensionId: string }) => dimension.dimensionId === ids.conditionDimensionId),
    ).toMatchObject({
      appliesWhen: [{ dimensionId: ids.formDimensionId, choiceIds: [ids.formRawChoiceId] }],
    });

    const sealedResponse = await app.request(`/api/marketplace/items/${ids.sealedItemId}`);
    expect(sealedResponse.status).toBe(200);
    const sealedBody = await sealedResponse.json();
    expect(sealedBody.version_schema).toMatchObject({
      canonicalDimensionOrder: [],
      dimensions: [],
    });
  });

  it("can rebuild the search index idempotently", async () => {
    await pool.query(`INSERT INTO discovery_search_catalog_items (item_id, title, status, updated_at) VALUES ('cat_test', 'Test Card', 'active', now())`);

    await rebuildDiscoverySearchIndex(pool);
    await rebuildDiscoverySearchIndex(pool);

    const result = await pool.query(`SELECT COUNT(*) AS count FROM discovery_search_items WHERE item_id = 'cat_test'`);
    expect(Number(result.rows[0].count)).toBe(1);
  });
});

