import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { Hono } from "hono";
import {
  buildDiscoveryApi,
  createDiscoveryServices,
  discoveryProjectionSchemaSql,
  rebuildDiscoverySearchIndex,
  type DiscoveryServices,
} from "..";
import {
  createCatalogServices,
  catalogAuthoringDatabaseSchemaSql,
  type CatalogServices,
} from "../../catalog/authoring";
import type { PgTransactionalPool } from "../../../contracts/event-core/postgres/types";
import type { EventStoreContext } from "../../../contracts/event-core/storage";

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
let discoveryServices: DiscoveryServices;
let app: Hono;

function createPool(connectionString: string): PgTransactionalPool {
  return new pg.Pool({ connectionString }) as unknown as PgTransactionalPool;
}

async function recreateSchema() {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await pool.query([catalogAuthoringDatabaseSchemaSql, discoveryProjectionSchemaSql].join("\n\n"));
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
    await sendCommand(catalogServices.dimensionHandler, `catalog.dimension-${itemSeed.dimensionId}`, {
      type: "CreateDimension",
      dimensionId: itemSeed.dimensionId as never,
      key: "condition",
      name: "Condition",
      description: "Card condition",
    });

    await sendCommand(catalogServices.dimensionHandler, `catalog.dimension-${itemSeed.dimensionId}`, {
      type: "AddChoice",
      choiceId: itemSeed.choiceId as never,
      code: "near-mint",
      labels: [{ locale: "en", value: "Near Mint" }],
      numericValue: null,
    });

    await sendCommand(catalogServices.dimensionHandler, `catalog.dimension-${itemSeed.dimensionId}`, {
      type: "ActivateDimension",
    });

    await sendCommand(catalogServices.fieldHandler, `catalog.field-${itemSeed.fieldId}`, {
      type: "CreateField",
      fieldId: itemSeed.fieldId as never,
      key: "card-name",
      name: "Card Name",
      description: "The printed card name",
      valueType: "string",
      behavior: { filterable: true, searchable: true, sortable: true },
    });

    await sendCommand(catalogServices.fieldHandler, `catalog.field-${itemSeed.fieldId}`, {
      type: "ActivateField",
    });

    await sendCommand(catalogServices.categoryHandler, `catalog.category-${itemSeed.categoryId}`, {
      type: "CreateCategory",
      categoryId: itemSeed.categoryId as never,
      key: "pokemon",
      name: "Pokemon",
      description: "Pokemon cards",
      displayOrder: 0,
    });

    await sendCommand(catalogServices.categoryHandler, `catalog.category-${itemSeed.categoryId}`, {
      type: "PublishCategory",
    });

    await sendCommand(catalogServices.blueprintHandler, `catalog.blueprint-${itemSeed.blueprintId}`, {
      type: "CreateBlueprint",
      blueprintId: itemSeed.blueprintId as never,
      key: "card",
      name: "Pokemon Card",
      description: "A tradable card",
    });

    await sendCommand(catalogServices.blueprintHandler, `catalog.blueprint-${itemSeed.blueprintId}`, {
      type: "SetBlueprintFields",
      fieldRules: [{ fieldId: itemSeed.fieldId as never, required: true }],
    });

    await sendCommand(catalogServices.blueprintHandler, `catalog.blueprint-${itemSeed.blueprintId}`, {
      type: "SetBlueprintDimensions",
      dimensionRules: [{
        dimensionId: itemSeed.dimensionId as never,
        required: true,
        allowedChoiceIds: [itemSeed.choiceId as never],
      }],
    });

    await sendCommand(catalogServices.blueprintHandler, `catalog.blueprint-${itemSeed.blueprintId}`, {
      type: "SetBlueprintVersionRules",
      canonicalDimensionOrder: [itemSeed.dimensionId as never],
    });

    await sendCommand(catalogServices.blueprintHandler, `catalog.blueprint-${itemSeed.blueprintId}`, {
      type: "PublishBlueprint",
    });

    await sendCommand(catalogServices.catalogItemHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "CreateItem",
      itemId: itemSeed.itemId as never,
      title: "Charizard",
      subtitle: "Base Set",
      description: "Classic fire-breathing favorite",
    });

    await sendCommand(catalogServices.catalogItemHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "AssignBlueprintToItem",
      blueprintId: itemSeed.blueprintId as never,
    });

    await sendCommand(catalogServices.catalogItemHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "SetItemFieldValue",
      fieldId: itemSeed.fieldId as never,
      value: "Charizard",
    });

    await sendCommand(catalogServices.catalogItemHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "AssignItemToCategory",
      categoryId: itemSeed.categoryId as never,
    });

    await sendCommand(catalogServices.catalogItemHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "SetItemTags",
      tags: ["fire", "vintage"],
    });

    await sendCommand(catalogServices.catalogItemHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "SetItemImageUrls",
      imageUrls: ["https://images.example/charizard.png"],
    });

    await sendCommand(catalogServices.catalogItemHandler, `catalog.item-${itemSeed.itemId}`, {
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

  it("can rebuild the search index idempotently", async () => {
    await pool.query(`INSERT INTO discovery_search_catalog_items (item_id, title, status, updated_at) VALUES ('cat_test', 'Test Card', 'active', now())`);

    await rebuildDiscoverySearchIndex(discoveryServices.db);
    await rebuildDiscoverySearchIndex(discoveryServices.db);

    const result = await pool.query(`SELECT COUNT(*) AS count FROM discovery_search_items WHERE item_id = 'cat_test'`);
    expect(Number(result.rows[0].count)).toBe(1);
  });
});

