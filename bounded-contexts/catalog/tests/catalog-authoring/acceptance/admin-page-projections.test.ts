import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { module as catalogModule } from "../../../index";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/index";
import { buildCatalogAuthoringTestApp } from "../../../support/authoring-support/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseBaseUrl ? describe : describe.skip;
const catalogContextNames = ["catalog"] as const;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed catalog authoring tests.");
  }

  return databaseBaseUrl;
}

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

describeWithDatabase("Admin page projections", () => {
  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      catalogContextNames,
      "catalog_authoring_acceptance",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    const pools = createMultiContextTestPools(databaseUrls);
    pool = pools.catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    services = createCatalogServices(pool);
    app = buildCatalogAuthoringTestApp(services, context);
  });

  afterAll(async () => {
    await closeMultiContextTestPools({ catalog: pool });
  });

  it("serves inline page DTOs and fans out referenced name changes", async () => {
    const dimensionId = "dim_condition";
    const optionId = "chc_near_mint";
    const fieldId = "fld_card_name";
    const componentId = "cmp_base_card_info";
    const blueprintId = "bpr_raw_pokemon_card";
    const rootCategoryId = "ctg_root";
    const childCategoryId = "ctg_child";
    const itemId = "cat_charizard";

    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${dimensionId}`, {
      type: "CreateDimension",
      dimensionId,
      key: "condition",
      name: "Condition",
      description: "Card condition",
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${dimensionId}`, {
      type: "AddOption",
      optionId,
      code: "near-mint",
      labels: [{ locale: "en", value: "Near Mint" }],
      numericValue: null,
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${dimensionId}`, { type: "ActivateDimension" });

    await sendCommand(services.fields.commandHandler, `catalog.field-${fieldId}`, {
      type: "CreateField",
      fieldId,
      key: "card-name",
      name: "Card Name",
      description: "Printed card name",
      valueType: "string",
      behavior: { filterable: true, searchable: true, sortable: true },
    });
    await sendCommand(services.fields.commandHandler, `catalog.field-${fieldId}`, { type: "ActivateField" });

    await sendCommand(services.components.commandHandler, `catalog.component-${componentId}`, {
      type: "CreateComponent",
      componentId,
      key: "base-card-info",
      name: "Base Card Info",
      description: "Core fields",
    });
    await sendCommand(services.components.commandHandler, `catalog.component-${componentId}`, {
      type: "AddFieldRuleToComponent",
      fieldId,
      required: true,
    });
    await sendCommand(services.components.commandHandler, `catalog.component-${componentId}`, {
      type: "AddDimensionRuleToComponent",
      dimensionId,
      required: true,
      allowedOptionIds: [optionId],
    });
    await sendCommand(services.components.commandHandler, `catalog.component-${componentId}`, { type: "ActivateComponent" });

    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "CreateBlueprint",
      blueprintId,
      key: "raw-pokemon-card",
      name: "Raw Pokemon Card",
      description: "Raw card template",
    });
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "AttachComponentToBlueprint",
      componentId,
    });
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "SetBlueprintFields",
      fieldRules: [{ fieldId, required: true }],
    });
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "SetBlueprintDimensions",
      dimensionRules: [{ dimensionId, required: true, allowedOptionIds: [optionId] }],
    });
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "SetBlueprintProductResolutionRules",
      canonicalDimensionOrder: [dimensionId],
    });
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, { type: "PublishBlueprint" });

    await sendCommand(services.categories.commandHandler, `catalog.category-${rootCategoryId}`, {
      type: "CreateCategory",
      categoryId: rootCategoryId,
      key: "pokemon-tcg",
      name: "Pokemon TCG",
      description: "Root category",
      parentCategoryId: undefined,
      displayOrder: 0,
    });
    await sendCommand(services.categories.commandHandler, `catalog.category-${rootCategoryId}`, { type: "PublishCategory" });

    await sendCommand(services.categories.commandHandler, `catalog.category-${childCategoryId}`, {
      type: "CreateCategory",
      categoryId: childCategoryId,
      key: "gen-1",
      name: "Generation I",
      description: "Generation I cards",
      parentCategoryId: rootCategoryId,
      displayOrder: 1,
    });
    await sendCommand(services.categories.commandHandler, `catalog.category-${childCategoryId}`, { type: "PublishCategory" });

    await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "CreateCatalogItem",
      itemId,
      title: "Charizard",
      subtitle: "Base Set",
      description: "A classic Charizard",
    });
    await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "AssignBlueprintToCatalogItem",
      blueprintId,
    });
    await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "SetCatalogItemFieldValue",
      fieldId,
      value: "Charizard",
    });
    await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "AssignCatalogItemToCategory",
      categoryId: childCategoryId,
    });
    await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "SetCatalogItemTags",
      tags: ["featured", "vintage"],
    });
    await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "PublishCatalogItem",
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
    expect(componentDetail.json.dimension_rules[0].allowedOptions[0]).toMatchObject({ optionId, code: "near-mint" });
    expect(componentDetail.json._resolved).toBeUndefined();

    const blueprintDetail = await getJson(`/api/catalog/blueprints/${blueprintId}`);
    expect(blueprintDetail.response.status).toBe(200);
    expect(blueprintDetail.json.components[0]).toMatchObject({ componentId, name: "Base Card Info" });
    expect(blueprintDetail.json.field_rules[0]).toMatchObject({ fieldId, fieldName: "Card Name" });
    expect(blueprintDetail.json.dimension_rules[0].allowedOptions[0]).toMatchObject({ optionId, code: "near-mint" });
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
      catalog_item_id: itemId,
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

    await sendCommand(services.fields.commandHandler, `catalog.field-${fieldId}`, {
      type: "ConfigureField",
      key: "card-name",
      name: "Card Title",
      description: "Printed card name",
      valueType: "string",
      behavior: { filterable: true, searchable: true, sortable: true },
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${dimensionId}`, {
      type: "ReviseDimension",
      key: "condition",
      name: "Card Condition",
      description: "Card condition",
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${dimensionId}`, {
      type: "ReviseOption",
      optionId,
      code: "mint",
      labels: [{ locale: "en", value: "Mint" }],
      numericValue: null,
    });
    await sendCommand(services.components.commandHandler, `catalog.component-${componentId}`, {
      type: "ConfigureComponentRules",
      key: "base-card-info",
      name: "Base Card Info V2",
      description: "Core fields",
      fieldRules: [{ fieldId, required: true }],
      dimensionRules: [{ dimensionId, required: true, allowedOptionIds: [optionId] }],
    });
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "ReviseBlueprint",
      key: "raw-pokemon-card",
      name: "Raw Pokemon Card V2",
      description: "Raw card template",
    });
    await sendCommand(services.categories.commandHandler, `catalog.category-${rootCategoryId}`, {
      type: "ReviseCategory",
      key: "pokemon-tcg",
      name: "Pokemon Catalog",
      description: "Root category",
      parentCategoryId: undefined,
      displayOrder: 0,
    });
    await sendCommand(services.categories.commandHandler, `catalog.category-${childCategoryId}`, {
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
    expect(updatedComponent.json.dimension_rules[0].allowedOptions[0].code).toBe("mint");

    const updatedBlueprint = await getJson(`/api/catalog/blueprints/${blueprintId}`);
    expect(updatedBlueprint.json.name).toBe("Raw Pokemon Card V2");
    expect(updatedBlueprint.json.components[0].name).toBe("Base Card Info V2");
    expect(updatedBlueprint.json.field_rules[0].fieldName).toBe("Card Title");
    expect(updatedBlueprint.json.dimension_rules[0].dimensionName).toBe("Card Condition");
    expect(updatedBlueprint.json.dimension_rules[0].allowedOptions[0].code).toBe("mint");

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

  it("includes conditional applicability in component and blueprint DTOs", async () => {
    const formDimensionId = "dim_form";
    const formRawOptionId = "chc_form_raw";
    const conditionDimensionId = "dim_condition";
    const conditionOptionId = "chc_condition_nm";
    const componentId = "cmp_single_card_product_resolution";
    const blueprintId = "bpr_card_single";

    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${formDimensionId}`, {
      type: "CreateDimension",
      dimensionId: formDimensionId,
      key: "form",
      name: "Form",
      description: "Card form",
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${formDimensionId}`, {
      type: "AddOption",
      optionId: formRawOptionId,
      code: "raw",
      labels: [{ locale: "en", value: "Raw" }],
      numericValue: null,
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${formDimensionId}`, { type: "ActivateDimension" });

    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${conditionDimensionId}`, {
      type: "CreateDimension",
      dimensionId: conditionDimensionId,
      key: "condition",
      name: "Condition",
      description: "Card condition",
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${conditionDimensionId}`, {
      type: "AddOption",
      optionId: conditionOptionId,
      code: "near-mint",
      labels: [{ locale: "en", value: "Near Mint" }],
      numericValue: null,
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${conditionDimensionId}`, { type: "ActivateDimension" });

    await sendCommand(services.components.commandHandler, `catalog.component-${componentId}`, {
      type: "CreateComponent",
      componentId,
      key: "single-card-product-resolution",
      name: "Single Card Product Resolution",
      description: "Product resolution rules",
    });
    await sendCommand(services.components.commandHandler, `catalog.component-${componentId}`, {
      type: "AddDimensionRuleToComponent",
      dimensionId: formDimensionId,
      required: true,
      allowedOptionIds: [formRawOptionId],
    });
    await sendCommand(services.components.commandHandler, `catalog.component-${componentId}`, {
      type: "AddDimensionRuleToComponent",
      dimensionId: conditionDimensionId,
      required: true,
      allowedOptionIds: [conditionOptionId],
      appliesWhen: [{ dimensionId: formDimensionId, optionIds: [formRawOptionId] }],
    });
    await sendCommand(services.components.commandHandler, `catalog.component-${componentId}`, { type: "ActivateComponent" });

    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "CreateBlueprint",
      blueprintId,
      key: "pokemon-card-single",
      name: "Pokemon Card Single",
      description: "Card blueprint",
    });
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "AttachComponentToBlueprint",
      componentId,
    });
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "SetBlueprintDimensions",
      dimensionRules: [
        { dimensionId: formDimensionId, required: true, allowedOptionIds: [formRawOptionId] },
        {
          dimensionId: conditionDimensionId,
          required: true,
          allowedOptionIds: [conditionOptionId],
          appliesWhen: [{ dimensionId: formDimensionId, optionIds: [formRawOptionId] }],
        },
      ],
    });
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "SetBlueprintProductResolutionRules",
      canonicalDimensionOrder: [formDimensionId, conditionDimensionId],
    });
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, { type: "PublishBlueprint" });

    await drainProjectors();

    const componentDetail = await getJson(`/api/catalog/components/${componentId}`);
    expect(componentDetail.response.status).toBe(200);
    const componentConditionRule = componentDetail.json.dimension_rules.find(
      (rule: { dimensionId: string }) => rule.dimensionId === conditionDimensionId,
    );
    expect(componentConditionRule.appliesWhen[0]).toMatchObject({
      dimensionId: formDimensionId,
      dimensionName: "Form",
      optionIds: [formRawOptionId],
    });
    expect(componentConditionRule.appliesWhen[0].options[0]).toMatchObject({
      optionId: formRawOptionId,
      code: "raw",
    });

    const blueprintDetail = await getJson(`/api/catalog/blueprints/${blueprintId}`);
    expect(blueprintDetail.response.status).toBe(200);
    const blueprintConditionRule = blueprintDetail.json.dimension_rules.find(
      (rule: { dimensionId: string }) => rule.dimensionId === conditionDimensionId,
    );
    expect(blueprintConditionRule.appliesWhen[0]).toMatchObject({
      dimensionId: formDimensionId,
      dimensionName: "Form",
      optionIds: [formRawOptionId],
    });
    expect(blueprintConditionRule.appliesWhen[0].options[0]).toMatchObject({
      optionId: formRawOptionId,
      code: "raw",
    });
  });
});
