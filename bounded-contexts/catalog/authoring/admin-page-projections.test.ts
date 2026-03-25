import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { catalogAuthoringDatabaseSchemaSql, createCatalogServices, type CatalogServices } from "./index";
import { buildCatalogAuthoringTestApp, createCatalogAuthoringTestPool } from "./test-support";
import type { EventStoreContext } from "../../../contracts/event-core/storage";
import type { PgTransactionalPool } from "../../../contracts/event-core/postgres/types";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://catalog:catalog@localhost:5432/catalog";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

const headers = {
  "x-tenant-id": "tnt_test",
  "x-user-id": "usr_test",
  "x-account-id": "acc_test",
};

let pool: PgTransactionalPool;
let services: CatalogServices;
let app: ReturnType<typeof buildCatalogAuthoringTestApp>;

async function recreateSchema() {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await pool.query(catalogAuthoringDatabaseSchemaSql);
}

async function drainProjectors() {
  let processed = 0;

  do {
    processed = 0;
    for (const projector of services.projectors) {
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
  const response = await app.fetch(new Request(`http://catalog.test${path}`, { headers }));
  return { response, json: await response.json() };
}

describe("Admin page projections", () => {
  beforeAll(() => {
    pool = createCatalogAuthoringTestPool(databaseUrl);
  });

  beforeEach(async () => {
    await recreateSchema();
    services = createCatalogServices(pool);
    app = buildCatalogAuthoringTestApp(services, context);
  });

  afterAll(async () => {
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("serves inline page DTOs and fans out referenced name changes", async () => {
    const dimensionId = "dim_condition";
    const choiceId = "chc_near_mint";
    const fieldId = "fld_card_name";
    const componentId = "cmp_base_card_info";
    const blueprintId = "bpr_raw_pokemon_card";
    const rootCategoryId = "ctg_root";
    const childCategoryId = "ctg_child";
    const itemId = "cat_charizard";

    await sendCommand(services.dimensionHandler, `catalog.dimension-${dimensionId}`, {
      type: "CreateDimension",
      dimensionId,
      key: "condition",
      name: "Condition",
      description: "Card condition",
    });
    await sendCommand(services.dimensionHandler, `catalog.dimension-${dimensionId}`, {
      type: "AddChoice",
      choiceId,
      code: "near-mint",
      labels: [{ locale: "en", value: "Near Mint" }],
      numericValue: null,
    });
    await sendCommand(services.dimensionHandler, `catalog.dimension-${dimensionId}`, { type: "ActivateDimension" });

    await sendCommand(services.fieldHandler, `catalog.field-${fieldId}`, {
      type: "CreateField",
      fieldId,
      key: "card-name",
      name: "Card Name",
      description: "Printed card name",
      valueType: "string",
      behavior: { filterable: true, searchable: true, sortable: true },
    });
    await sendCommand(services.fieldHandler, `catalog.field-${fieldId}`, { type: "ActivateField" });

    await sendCommand(services.componentHandler, `catalog.component-${componentId}`, {
      type: "CreateComponent",
      componentId,
      key: "base-card-info",
      name: "Base Card Info",
      description: "Core fields",
    });
    await sendCommand(services.componentHandler, `catalog.component-${componentId}`, {
      type: "AddFieldRuleToComponent",
      fieldId,
      required: true,
    });
    await sendCommand(services.componentHandler, `catalog.component-${componentId}`, {
      type: "AddDimensionRuleToComponent",
      dimensionId,
      required: true,
      allowedChoiceIds: [choiceId],
    });
    await sendCommand(services.componentHandler, `catalog.component-${componentId}`, { type: "ActivateComponent" });

    await sendCommand(services.blueprintHandler, `catalog.blueprint-${blueprintId}`, {
      type: "CreateBlueprint",
      blueprintId,
      key: "raw-pokemon-card",
      name: "Raw Pokemon Card",
      description: "Raw card template",
    });
    await sendCommand(services.blueprintHandler, `catalog.blueprint-${blueprintId}`, {
      type: "AttachComponentToBlueprint",
      componentId,
    });
    await sendCommand(services.blueprintHandler, `catalog.blueprint-${blueprintId}`, {
      type: "SetBlueprintFields",
      fieldRules: [{ fieldId, required: true }],
    });
    await sendCommand(services.blueprintHandler, `catalog.blueprint-${blueprintId}`, {
      type: "SetBlueprintDimensions",
      dimensionRules: [{ dimensionId, required: true, allowedChoiceIds: [choiceId] }],
    });
    await sendCommand(services.blueprintHandler, `catalog.blueprint-${blueprintId}`, {
      type: "SetBlueprintVersionRules",
      canonicalDimensionOrder: [dimensionId],
    });
    await sendCommand(services.blueprintHandler, `catalog.blueprint-${blueprintId}`, { type: "PublishBlueprint" });

    await sendCommand(services.categoryHandler, `catalog.category-${rootCategoryId}`, {
      type: "CreateCategory",
      categoryId: rootCategoryId,
      key: "pokemon-tcg",
      name: "Pokemon TCG",
      description: "Root category",
      parentCategoryId: undefined,
      displayOrder: 0,
    });
    await sendCommand(services.categoryHandler, `catalog.category-${rootCategoryId}`, { type: "PublishCategory" });

    await sendCommand(services.categoryHandler, `catalog.category-${childCategoryId}`, {
      type: "CreateCategory",
      categoryId: childCategoryId,
      key: "gen-1",
      name: "Generation I",
      description: "Generation I cards",
      parentCategoryId: rootCategoryId,
      displayOrder: 1,
    });
    await sendCommand(services.categoryHandler, `catalog.category-${childCategoryId}`, { type: "PublishCategory" });

    await sendCommand(services.catalogItemHandler, `catalog.item-${itemId}`, {
      type: "CreateItem",
      itemId,
      title: "Charizard",
      subtitle: "Base Set",
      description: "A classic Charizard",
    });
    await sendCommand(services.catalogItemHandler, `catalog.item-${itemId}`, {
      type: "AssignBlueprintToItem",
      blueprintId,
    });
    await sendCommand(services.catalogItemHandler, `catalog.item-${itemId}`, {
      type: "SetItemFieldValue",
      fieldId,
      value: "Charizard",
    });
    await sendCommand(services.catalogItemHandler, `catalog.item-${itemId}`, {
      type: "AssignItemToCategory",
      categoryId: childCategoryId,
    });
    await sendCommand(services.catalogItemHandler, `catalog.item-${itemId}`, {
      type: "SetItemTags",
      tags: ["featured", "vintage"],
    });
    await sendCommand(services.catalogItemHandler, `catalog.item-${itemId}`, {
      type: "PublishItem",
      blueprintIsActive: true,
      requiredFieldIds: [fieldId],
    });

    await drainProjectors();

    const componentDetail = await getJson(`/api/catalog/components/${componentId}`);
    expect(componentDetail.response.status).toBe(200);
    expect(componentDetail.json.field_rules[0]).toMatchObject({ fieldId, fieldName: "Card Name", required: true });
    expect(componentDetail.json.dimension_rules[0]).toMatchObject({
      dimensionId,
      dimensionName: "Condition",
      required: true,
    });
    expect(componentDetail.json.dimension_rules[0].allowedChoices[0]).toMatchObject({ choiceId, code: "near-mint" });
    expect(componentDetail.json._resolved).toBeUndefined();

    const blueprintDetail = await getJson(`/api/catalog/blueprints/${blueprintId}`);
    expect(blueprintDetail.response.status).toBe(200);
    expect(blueprintDetail.json.components[0]).toMatchObject({ componentId, name: "Base Card Info" });
    expect(blueprintDetail.json.field_rules[0]).toMatchObject({ fieldId, fieldName: "Card Name" });
    expect(blueprintDetail.json.dimension_rules[0].allowedChoices[0]).toMatchObject({ choiceId, code: "near-mint" });
    expect(blueprintDetail.json.canonical_dimension_order[0]).toMatchObject({ dimensionId, dimensionName: "Condition" });

    const categoryList = await getJson(`/api/catalog/categories?status=active&parentCategoryId=${rootCategoryId}&limit=1&offset=0`);
    expect(categoryList.response.status).toBe(200);
    expect(categoryList.json.total).toBe(1);
    expect(categoryList.json.items[0]).toMatchObject({
      category_id: childCategoryId,
      parent_category: { categoryId: rootCategoryId, name: "Pokemon TCG" },
    });
    expect(categoryList.json._resolvedNames).toBeUndefined();

    const categoryDetail = await getJson(`/api/catalog/categories/${childCategoryId}`);
    expect(categoryDetail.response.status).toBe(200);
    expect(categoryDetail.json.parent_category).toMatchObject({ categoryId: rootCategoryId, name: "Pokemon TCG" });

    const itemList = await getJson(`/api/catalog/items?status=active&blueprintId=${blueprintId}&tag=featured&limit=1&offset=0`);
    expect(itemList.response.status).toBe(200);
    expect(itemList.json.total).toBe(1);
    expect(itemList.json.items[0]).toMatchObject({
      item_id: itemId,
      blueprint: { blueprintId, name: "Raw Pokemon Card" },
    });
    expect(itemList.json._resolvedNames).toBeUndefined();

    const itemDetail = await getJson(`/api/catalog/items/${itemId}`);
    expect(itemDetail.response.status).toBe(200);
    expect(itemDetail.json.blueprint).toMatchObject({ blueprintId, name: "Raw Pokemon Card" });
    expect(itemDetail.json.field_values[0]).toMatchObject({ fieldId, fieldName: "Card Name", value: "Charizard" });
    expect(itemDetail.json.categories[0]).toMatchObject({ categoryId: childCategoryId, name: "Generation I" });

    const missingBlueprintResolver = await app.fetch(new Request(`http://catalog.test/api/catalog/blueprints/${blueprintId}/resolve-names`, { headers }));
    expect(missingBlueprintResolver.status).toBe(404);

    const missingItemResolver = await app.fetch(new Request(`http://catalog.test/api/catalog/items/${itemId}/resolve-names`, { headers }));
    expect(missingItemResolver.status).toBe(404);

    await sendCommand(services.fieldHandler, `catalog.field-${fieldId}`, {
      type: "ConfigureField",
      key: "card-name",
      name: "Card Title",
      description: "Printed card name",
      valueType: "string",
      behavior: { filterable: true, searchable: true, sortable: true },
    });
    await sendCommand(services.dimensionHandler, `catalog.dimension-${dimensionId}`, {
      type: "ReviseDimension",
      key: "condition",
      name: "Card Condition",
      description: "Card condition",
    });
    await sendCommand(services.dimensionHandler, `catalog.dimension-${dimensionId}`, {
      type: "ReviseChoice",
      choiceId,
      code: "mint",
      labels: [{ locale: "en", value: "Mint" }],
      numericValue: null,
    });
    await sendCommand(services.componentHandler, `catalog.component-${componentId}`, {
      type: "ConfigureComponentRules",
      key: "base-card-info",
      name: "Base Card Info V2",
      description: "Core fields",
      fieldRules: [{ fieldId, required: true }],
      dimensionRules: [{ dimensionId, required: true, allowedChoiceIds: [choiceId] }],
    });
    await sendCommand(services.blueprintHandler, `catalog.blueprint-${blueprintId}`, {
      type: "ReviseBlueprint",
      key: "raw-pokemon-card",
      name: "Raw Pokemon Card V2",
      description: "Raw card template",
    });
    await sendCommand(services.categoryHandler, `catalog.category-${rootCategoryId}`, {
      type: "ReviseCategory",
      key: "pokemon-tcg",
      name: "Pokemon Catalog",
      description: "Root category",
      parentCategoryId: undefined,
      displayOrder: 0,
    });
    await sendCommand(services.categoryHandler, `catalog.category-${childCategoryId}`, {
      type: "ReviseCategory",
      key: "gen-1",
      name: "Generation I Singles",
      description: "Generation I cards",
      parentCategoryId: rootCategoryId,
      displayOrder: 1,
    });

    await drainProjectors();

    const updatedComponent = await getJson(`/api/catalog/components/${componentId}`);
    expect(updatedComponent.json.name).toBe("Base Card Info V2");
    expect(updatedComponent.json.field_rules[0].fieldName).toBe("Card Title");
    expect(updatedComponent.json.dimension_rules[0].dimensionName).toBe("Card Condition");
    expect(updatedComponent.json.dimension_rules[0].allowedChoices[0].code).toBe("mint");

    const updatedBlueprint = await getJson(`/api/catalog/blueprints/${blueprintId}`);
    expect(updatedBlueprint.json.name).toBe("Raw Pokemon Card V2");
    expect(updatedBlueprint.json.components[0].name).toBe("Base Card Info V2");
    expect(updatedBlueprint.json.field_rules[0].fieldName).toBe("Card Title");
    expect(updatedBlueprint.json.dimension_rules[0].dimensionName).toBe("Card Condition");
    expect(updatedBlueprint.json.dimension_rules[0].allowedChoices[0].code).toBe("mint");

    const updatedCategoryList = await getJson(`/api/catalog/categories?status=active&parentCategoryId=${rootCategoryId}`);
    expect(updatedCategoryList.json.items[0].name).toBe("Generation I Singles");
    expect(updatedCategoryList.json.items[0].parent_category.name).toBe("Pokemon Catalog");

    const updatedCategoryDetail = await getJson(`/api/catalog/categories/${childCategoryId}`);
    expect(updatedCategoryDetail.json.name).toBe("Generation I Singles");
    expect(updatedCategoryDetail.json.parent_category.name).toBe("Pokemon Catalog");

    const updatedItemList = await getJson(`/api/catalog/items?status=active&blueprintId=${blueprintId}&tag=featured`);
    expect(updatedItemList.json.items[0].blueprint.name).toBe("Raw Pokemon Card V2");

    const updatedItemDetail = await getJson(`/api/catalog/items/${itemId}`);
    expect(updatedItemDetail.json.blueprint.name).toBe("Raw Pokemon Card V2");
    expect(updatedItemDetail.json.field_values[0].fieldName).toBe("Card Title");
    expect(updatedItemDetail.json.categories[0].name).toBe("Generation I Singles");
  });
});
