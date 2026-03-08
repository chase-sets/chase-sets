import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildMarketplaceApp } from "../src/app";
import { createPool } from "../src/infrastructure/postgres";
import { createMarketplaceServices, type MarketplaceServices } from "../src/infrastructure/wiring";
import { rebuildMarketplaceSearchIndex } from "../src/projections/search-item-projection";
import { createCatalogServices, type CatalogServices } from "../../catalog-api/src/infrastructure/wiring";
import type { PgTransactionalPool } from "../../../contracts/event-core/postgres/types";
import type { EventStoreContext } from "../../../contracts/event-core/storage";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://catalog:catalog@localhost:5432/catalog";
const initSql = readFileSync(new URL("../init-db.sql", import.meta.url), "utf8");

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

let pool: PgTransactionalPool;
let catalogServices: CatalogServices;
let marketplaceServices: MarketplaceServices;
let app: ReturnType<typeof buildMarketplaceApp>;

async function recreateSchema() {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await pool.query(initSql);
}

async function drainProjectors() {
  let processed = 0;

  do {
    processed = 0;
    for (const projector of marketplaceServices.projectors) {
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

async function getJson(path: string) {
  const response = await app.fetch(new Request(`http://marketplace.test${path}`));
  return { response, json: await response.json() };
}

async function seedMarketplaceFixture() {
  const categoryId = "ctg_pokemon";
  const blueprintId = "bpr_card";
  const cardNumberFieldId = "fld_card_number";
  const cardNameFieldId = "fld_card_name";

  await sendCommand(catalogServices.fieldHandler, `catalog.field-${cardNumberFieldId}`, {
    type: "CreateField",
    fieldId: cardNumberFieldId,
    key: "card-number",
    name: "Card Number",
    description: "Collector number",
    valueType: "string",
    behavior: { filterable: true, searchable: false, sortable: true },
  });
  await sendCommand(catalogServices.fieldHandler, `catalog.field-${cardNumberFieldId}`, { type: "ActivateField" });

  await sendCommand(catalogServices.fieldHandler, `catalog.field-${cardNameFieldId}`, {
    type: "CreateField",
    fieldId: cardNameFieldId,
    key: "card-name",
    name: "Card Name",
    description: "Printed card name",
    valueType: "string",
    behavior: { filterable: true, searchable: true, sortable: true },
  });
  await sendCommand(catalogServices.fieldHandler, `catalog.field-${cardNameFieldId}`, { type: "ActivateField" });

  await sendCommand(catalogServices.blueprintHandler, `catalog.blueprint-${blueprintId}`, {
    type: "CreateBlueprint",
    blueprintId,
    key: "pokemon-card",
    name: "Pokemon Card",
    description: "Pokemon card listing",
  });
  await sendCommand(catalogServices.blueprintHandler, `catalog.blueprint-${blueprintId}`, {
    type: "SetBlueprintFields",
    fieldRules: [
      { fieldId: cardNumberFieldId, required: true },
      { fieldId: cardNameFieldId, required: true },
    ],
  });
  await sendCommand(catalogServices.blueprintHandler, `catalog.blueprint-${blueprintId}`, {
    type: "SetBlueprintVersionRules",
    canonicalDimensionOrder: [],
  });
  await sendCommand(catalogServices.blueprintHandler, `catalog.blueprint-${blueprintId}`, {
    type: "PublishBlueprint",
  });

  await sendCommand(catalogServices.categoryHandler, `catalog.category-${categoryId}`, {
    type: "CreateCategory",
    categoryId,
    key: "pokemon-tcg",
    name: "Pokemon TCG",
    description: "Pokemon singles",
    parentCategoryId: null,
    displayOrder: 0,
  });
  await sendCommand(catalogServices.categoryHandler, `catalog.category-${categoryId}`, {
    type: "PublishCategory",
  });

  for (const item of [
    {
      itemId: "itm_charizard_raw",
      title: "Charizard - Base Set 4/102",
      subtitle: "Holo Rare - Near Mint",
      description: "Classic Base Set Charizard.",
      cardNumber: "4/102",
      cardName: "Charizard",
      tags: ["charizard", "base-set"],
    },
    {
      itemId: "itm_charizard_psa10",
      title: "Charizard - Base Set 4/102 PSA 10",
      subtitle: "Gem Mint - PSA Graded",
      description: "PSA 10 Base Set Charizard.",
      cardNumber: "4/102",
      cardName: "Charizard",
      tags: ["charizard", "psa-10"],
    },
    {
      itemId: "itm_pikachu_raw",
      title: "Pikachu - Jungle 60/64",
      subtitle: "Unlimited - Near Mint",
      description: "Classic Jungle Pikachu.",
      cardNumber: "60/64",
      cardName: "Pikachu",
      tags: ["pikachu", "jungle"],
    },
  ]) {
    await sendCommand(catalogServices.catalogItemHandler, `catalog.item-${item.itemId}`, {
      type: "CreateItem",
      itemId: item.itemId,
      title: item.title,
      subtitle: item.subtitle,
      description: item.description,
    });
    await sendCommand(catalogServices.catalogItemHandler, `catalog.item-${item.itemId}`, {
      type: "AssignBlueprintToItem",
      blueprintId,
    });
    await sendCommand(catalogServices.catalogItemHandler, `catalog.item-${item.itemId}`, {
      type: "SetItemFieldValue",
      fieldId: cardNumberFieldId,
      value: item.cardNumber,
    });
    await sendCommand(catalogServices.catalogItemHandler, `catalog.item-${item.itemId}`, {
      type: "SetItemFieldValue",
      fieldId: cardNameFieldId,
      value: item.cardName,
    });
    await sendCommand(catalogServices.catalogItemHandler, `catalog.item-${item.itemId}`, {
      type: "AssignItemToCategory",
      categoryId,
    });
    await sendCommand(catalogServices.catalogItemHandler, `catalog.item-${item.itemId}`, {
      type: "SetItemTags",
      tags: item.tags,
    });
    await sendCommand(catalogServices.catalogItemHandler, `catalog.item-${item.itemId}`, {
      type: "PublishItem",
      blueprintIsActive: true,
      requiredFieldIds: [cardNumberFieldId, cardNameFieldId],
    });
  }

  await drainProjectors();
}

describe("marketplace search", () => {
  beforeAll(() => {
    pool = createPool(databaseUrl);
  });

  beforeEach(async () => {
    await recreateSchema();
    catalogServices = createCatalogServices(pool);
    marketplaceServices = createMarketplaceServices(pool);
    app = buildMarketplaceApp(marketplaceServices);
  });

  afterAll(async () => {
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("matches token-aware numeric collector number queries", async () => {
    await seedMarketplaceFixture();

    const numeric = await getJson("/api/marketplace/items?search=4");
    expect(numeric.response.status).toBe(200);
    expect(numeric.json.total).toBe(2);
    expect(numeric.json.items.map((item: { title: string }) => item.title)).toEqual(
      expect.arrayContaining([
        "Charizard - Base Set 4/102",
        "Charizard - Base Set 4/102 PSA 10",
      ]),
    );

    const collector = await getJson("/api/marketplace/items?search=4%2F102");
    expect(collector.response.status).toBe(200);
    expect(collector.json.total).toBe(2);
    expect(collector.json.items.map((item: { title: string }) => item.title)).toEqual(
      expect.arrayContaining([
        "Charizard - Base Set 4/102",
        "Charizard - Base Set 4/102 PSA 10",
      ]),
    );

    const text = await getJson("/api/marketplace/items?search=charizard");
    expect(text.response.status).toBe(200);
    expect(text.json.total).toBe(2);

    const partial = await getJson("/api/marketplace/items?search=02");
    expect(partial.response.status).toBe(200);
    expect(partial.json.total).toBe(0);
  });

  it("rebuilds the marketplace search index idempotently", async () => {
    await seedMarketplaceFixture();

    await pool.query(`TRUNCATE marketplace_search_items`);
    await rebuildMarketplaceSearchIndex(marketplaceServices.db);
    await rebuildMarketplaceSearchIndex(marketplaceServices.db);

    const rows = await pool.query<{
      item_id: string;
      has_search_text: boolean;
      has_search_text_simple: boolean;
    }>(
      `SELECT item_id, search_text IS NOT NULL AS has_search_text, search_text_simple IS NOT NULL AS has_search_text_simple
       FROM marketplace_search_items
       ORDER BY item_id ASC`,
    );

    expect(rows.rows).toEqual([
      {
        item_id: "itm_charizard_psa10",
        has_search_text: true,
        has_search_text_simple: true,
      },
      {
        item_id: "itm_charizard_raw",
        has_search_text: true,
        has_search_text_simple: true,
      },
      {
        item_id: "itm_pikachu_raw",
        has_search_text: true,
        has_search_text_simple: true,
      },
    ]);

    const numeric = await getJson("/api/marketplace/items?search=4");
    expect(numeric.response.status).toBe(200);
    expect(numeric.json.total).toBe(2);
  });
});
