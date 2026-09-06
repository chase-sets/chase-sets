import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  bootstrapContextDatabase,
  drainContextProcesses,
  resolveModuleSubscriptions,
} from "@chase-sets/bounded-context-runtime";
import { module as catalogModule } from "../../../index";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/index";
import { buildCatalogAuthoringTestApp } from "../../../support/authoring-support/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
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

function l10n(en: string, values: Record<string, string> = {}) {
  return {
    defaultLocale: "en" as const,
    values: { en, ...values },
  };
}

let pool: PgTransactionalPool;
let services: CatalogServices;
let app: ReturnType<typeof buildCatalogAuthoringTestApp>;
let subscriptionRunners: ReturnType<typeof resolveModuleSubscriptions>;

async function drainCatalogProjectionSubscriptions() {
  await drainContextProcesses({ subscriptionRunners });
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
    subscriptionRunners = resolveModuleSubscriptions([
      {
        contextName: "catalog",
        module: catalogModule,
        services,
        pool,
        projectionHandlerSets: catalogModule.projectionHandlerSets?.(services) ?? [],
      },
    ]);
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
    const japaneseItemId = "cat_charizard_ja";
    const displayTemplateId = "dtp_catalog_item_default";

    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${dimensionId}`, {
      type: "CreateDimension",
      dimensionId,
      key: "condition",
      name: l10n("Condition"),
      description: l10n("Card condition"),
      valueKind: "ordered",
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${dimensionId}`, {
      type: "AddOption",
      optionId,
      code: "near-mint",
      label: l10n("Near Mint"),
      numericValue: 5,
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${dimensionId}`, {
      type: "ActivateDimension",
    });

    await sendCommand(services.fields.commandHandler, `catalog.field-${fieldId}`, {
      type: "CreateField",
      fieldId,
      key: "card-name",
      name: l10n("Card Name"),
      description: l10n("Printed card name"),
      valueType: "localized_text",
      behavior: { filterable: true, searchable: true, sortable: true },
    });
    await sendCommand(services.fields.commandHandler, `catalog.field-${fieldId}`, { type: "ActivateField" });

    await sendCommand(services.components.commandHandler, `catalog.component-${componentId}`, {
      type: "CreateComponent",
      componentId,
      key: "base-card-info",
      name: l10n("Base Card Info"),
      description: l10n("Core fields"),
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
    await sendCommand(services.components.commandHandler, `catalog.component-${componentId}`, {
      type: "ActivateComponent",
    });

    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "CreateBlueprint",
      blueprintId,
      key: "raw-pokemon-card",
      name: l10n("Raw Pokemon Card"),
      description: l10n("Raw card template"),
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
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "PublishBlueprint",
    });

    await sendCommand(services.categories.commandHandler, `catalog.category-${rootCategoryId}`, {
      type: "CreateCategory",
      categoryId: rootCategoryId,
      key: "pokemon-tcg",
      name: l10n("Pokemon TCG"),
      description: l10n("Root category"),
      parentCategoryId: undefined,
      displayOrder: 0,
    });
    await sendCommand(services.categories.commandHandler, `catalog.category-${rootCategoryId}`, {
      type: "PublishCategory",
    });

    await sendCommand(services.categories.commandHandler, `catalog.category-${childCategoryId}`, {
      type: "CreateCategory",
      categoryId: childCategoryId,
      key: "gen-1",
      name: l10n("Generation I"),
      description: l10n("Generation I cards"),
      parentCategoryId: rootCategoryId,
      displayOrder: 1,
    });
    await sendCommand(services.categories.commandHandler, `catalog.category-${childCategoryId}`, {
      type: "PublishCategory",
    });

    await drainCatalogProjectionSubscriptions();
    await sendCommand(services.displayTemplates.commandHandler, `catalog.display-template-${displayTemplateId}`, {
      type: "CreateDisplayTemplate",
      displayTemplateId,
      key: "catalog-item-default",
      name: l10n("Catalog item default"),
      description: l10n("Test publication identity"),
      target: { kind: "global" },
      priority: 0,
      titleTemplate: "{item.title}",
      subtitleTemplate: "{item.subtitle}",
    });
    await sendCommand(services.displayTemplates.commandHandler, `catalog.display-template-${displayTemplateId}`, {
      type: "PublishDisplayTemplate",
    });
    await drainCatalogProjectionSubscriptions();

    await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "CreateCatalogItem",
      itemId,
      title: l10n("Charizard"),
      subtitle: l10n("Base Set"),
      description: l10n("A classic Charizard"),
    });
    await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "AssignBlueprintToCatalogItem",
      blueprintId,
    });
    await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "SetCatalogItemFieldValue",
      fieldId,
      value: l10n("Charizard"),
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
      type: "LinkExternalProductReference",
      providerKey: "tcgplayer",
      externalKey: "base-set-charizard",
      selectedOptions: [],
    });
    await drainCatalogProjectionSubscriptions();
    await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "PublishCatalogItem",
      blueprintIsActive: true,
      requiredFieldIds: [fieldId],
    });

    await sendCommand(services.items.commandHandler, `catalog.item-${japaneseItemId}`, {
      type: "CreateCatalogItem",
      itemId: japaneseItemId,
      languageCode: "ja",
      title: l10n("Charizard", { ja: "リザードン" }),
      subtitle: l10n("Japanese Base Set", { ja: "拡張パック" }),
      description: l10n("Japanese printed Charizard", { ja: "日本語版リザードン" }),
    });

    await drainCatalogProjectionSubscriptions();

    const dimensionDetail = await getJson(`/api/catalog/dimensions/${dimensionId}`);
    expect(dimensionDetail.response.status).toBe(200);
    expect(dimensionDetail.json).toMatchObject({ value_kind: "ordered" });
    expect(dimensionDetail.json.options[0]).toMatchObject({
      option_id: optionId,
      display_order: 0,
      numeric_value: 5,
    });

    const componentDetail = await getJson(`/api/catalog/components/${componentId}`);
    expect(componentDetail.response.status).toBe(200);
    expect(componentDetail.json.field_rules[0]).toMatchObject({ fieldId, fieldName: "Card Name", required: true });
    expect(componentDetail.json.dimension_rules[0]).toMatchObject({
      dimensionId,
      dimensionName: "Condition",
      required: true,
    });
    expect(componentDetail.json.dimension_rules[0].allowedOptions[0]).toMatchObject({
      optionId,
      code: "near-mint",
      displayOrder: 0,
      numericValue: 5,
    });
    expect(componentDetail.json._resolved).toBeUndefined();

    const blueprintDetail = await getJson(`/api/catalog/blueprints/${blueprintId}`);
    expect(blueprintDetail.response.status).toBe(200);
    expect(blueprintDetail.json.components[0]).toMatchObject({ componentId, name: "Base Card Info" });
    expect(blueprintDetail.json.field_rules[0]).toMatchObject({ fieldId, fieldName: "Card Name" });
    expect(blueprintDetail.json.dimension_rules[0].allowedOptions[0]).toMatchObject({
      optionId,
      code: "near-mint",
      displayOrder: 0,
      numericValue: 5,
    });
    expect(blueprintDetail.json.canonical_dimension_order[0]).toMatchObject({
      dimensionId,
      dimensionName: "Condition",
    });

    const categoryList = await getJson(
      `/api/catalog/categories?status=active&parentCategoryId=${rootCategoryId}&limit=1&offset=0`,
    );
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

    const itemList = await getJson(
      `/api/catalog/items?status=active&blueprintId=${blueprintId}&tag=featured&limit=1&offset=0`,
    );
    expect(itemList.response.status).toBe(200);
    expect(itemList.json.total).toBe(1);
    expect(itemList.json.items[0]).toMatchObject({
      catalog_item_id: itemId,
      language_code: "en",
      title: "Charizard",
      title_i18n: { defaultLocale: "en", values: { en: "Charizard" } },
      subtitle_i18n: { defaultLocale: "en", values: { en: "Base Set" } },
      blueprint: { blueprintId, name: "Raw Pokemon Card" },
      source_providers: ["tcgplayer"],
    });
    expect(itemList.json._resolvedNames).toBeUndefined();

    const itemSourceList = await getJson(`/api/catalog/items?status=active&source=tcgplayer&limit=5&offset=0`);
    expect(itemSourceList.response.status).toBe(200);
    expect(itemSourceList.json.total).toBe(1);
    expect(itemSourceList.json.items[0]).toMatchObject({
      catalog_item_id: itemId,
      source_providers: ["tcgplayer"],
    });

    const japaneseItemList = await getJson("/api/catalog/items?language=ja&limit=5&offset=0");
    expect(japaneseItemList.response.status).toBe(200);
    expect(japaneseItemList.json.total).toBe(1);
    expect(japaneseItemList.json.items[0]).toMatchObject({
      catalog_item_id: japaneseItemId,
      language_code: "ja",
      title: "Charizard",
      title_i18n: { defaultLocale: "en", values: { en: "Charizard", ja: "リザードン" } },
    });

    const itemDetail = await getJson(`/api/catalog/items/${itemId}`);
    expect(itemDetail.response.status).toBe(200);
    expect(itemDetail.json).toMatchObject({
      language_code: "en",
      title_i18n: { defaultLocale: "en", values: { en: "Charizard" } },
      subtitle_i18n: { defaultLocale: "en", values: { en: "Base Set" } },
      description_i18n: { defaultLocale: "en", values: { en: "A classic Charizard" } },
      title: "Charizard",
      subtitle: "Base Set",
      description: "A classic Charizard",
    });
    expect(itemDetail.json.blueprint).toMatchObject({ blueprintId, name: "Raw Pokemon Card" });
    expect(itemDetail.json.field_values[0]).toMatchObject({
      fieldId,
      fieldName: "Card Name",
      value: l10n("Charizard"),
    });
    expect(itemDetail.json.categories[0]).toMatchObject({ categoryId: childCategoryId, name: "Generation I" });

    const missingBlueprintResolver = await app.fetch(
      new Request(`http://catalog.test/api/catalog/blueprints/${blueprintId}/resolve-names`, { headers }),
    );
    expect(missingBlueprintResolver.status).toBe(404);

    const missingItemResolver = await app.fetch(
      new Request(`http://catalog.test/api/catalog/items/${itemId}/resolve-names`, { headers }),
    );
    expect(missingItemResolver.status).toBe(404);

    await sendCommand(services.fields.commandHandler, `catalog.field-${fieldId}`, {
      type: "ConfigureField",
      key: "card-name",
      name: l10n("Card Title"),
      description: l10n("Printed card name"),
      valueType: "localized_text",
      behavior: { filterable: true, searchable: true, sortable: true },
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${dimensionId}`, {
      type: "ReviseDimension",
      key: "condition",
      name: l10n("Card Condition"),
      description: l10n("Card condition"),
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${dimensionId}`, {
      type: "ReviseOption",
      optionId,
      code: "mint",
      label: l10n("Mint"),
      numericValue: null,
    });
    await sendCommand(services.components.commandHandler, `catalog.component-${componentId}`, {
      type: "ConfigureComponentRules",
      key: "base-card-info",
      name: l10n("Base Card Info V2"),
      description: l10n("Core fields"),
      fieldRules: [{ fieldId, required: true }],
      dimensionRules: [{ dimensionId, required: true, allowedOptionIds: [optionId] }],
    });
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "ReviseBlueprint",
      key: "raw-pokemon-card",
      name: l10n("Raw Pokemon Card V2"),
      description: l10n("Raw card template"),
    });
    await sendCommand(services.categories.commandHandler, `catalog.category-${rootCategoryId}`, {
      type: "ReviseCategory",
      key: "pokemon-tcg",
      name: l10n("Pokemon Catalog"),
      description: l10n("Root category"),
      parentCategoryId: undefined,
      displayOrder: 0,
    });
    await sendCommand(services.categories.commandHandler, `catalog.category-${childCategoryId}`, {
      type: "ReviseCategory",
      key: "gen-1",
      name: l10n("Generation I Singles"),
      description: l10n("Generation I cards"),
      parentCategoryId: rootCategoryId,
      displayOrder: 1,
    });

    await drainCatalogProjectionSubscriptions();

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

    const updatedCategoryList = await getJson(
      `/api/catalog/categories?status=active&parentCategoryId=${rootCategoryId}`,
    );
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

  it("expands rich reference records from catalog item field values", async () => {
    const setTypeId = "rft_set";
    const seriesTypeId = "rft_series";
    const setFieldId = "fld_set";
    const seriesReferenceId = "ref_mega_evolution";
    const setReferenceId = "ref_ascended_heroes";
    const itemId = "cat_azumarill_ex";

    await sendCommand(services.referenceData.referenceTypeCommandHandler, `catalog.reference-type-${setTypeId}`, {
      type: "CreateReferenceType",
      referenceTypeId: setTypeId,
      key: "set",
      name: l10n("Set"),
      description: l10n("Card set"),
      attributeKeys: ["card-count", "release-date", "abbreviation", "source-id"],
    });
    await sendCommand(services.referenceData.referenceTypeCommandHandler, `catalog.reference-type-${seriesTypeId}`, {
      type: "CreateReferenceType",
      referenceTypeId: seriesTypeId,
      key: "series",
      name: l10n("Series"),
      description: l10n("Product series"),
      attributeKeys: [],
    });
    await sendCommand(
      services.referenceData.referenceRecordCommandHandler,
      `catalog.reference-record-${seriesReferenceId}`,
      {
        type: "CreateReferenceRecord",
        referenceRecordId: seriesReferenceId,
        typeKey: "series",
        key: "mega-evolution",
        name: l10n("Mega Evolution"),
        description: l10n("Mega Evolution series"),
        attributes: {},
        relationships: [],
      },
    );
    await sendCommand(
      services.referenceData.referenceRecordCommandHandler,
      `catalog.reference-record-${setReferenceId}`,
      {
        type: "CreateReferenceRecord",
        referenceRecordId: setReferenceId,
        typeKey: "set",
        key: "ascended-heroes",
        name: l10n("Ascended Heroes"),
        description: l10n("Ascended Heroes set"),
        attributes: {
          "card-count": 217,
          "release-date": "2026-01-30",
          abbreviation: "ASC",
          "source-id": "me02.5",
        },
        relationships: [
          {
            relationshipType: "part-of-series",
            referenceId: seriesReferenceId,
          },
        ],
      },
    );

    await sendCommand(services.fields.commandHandler, `catalog.field-${setFieldId}`, {
      type: "CreateField",
      fieldId: setFieldId,
      key: "set",
      name: l10n("Set"),
      description: l10n("Card set"),
      valueType: "reference",
      behavior: { filterable: true, searchable: true, sortable: false },
    });
    await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "CreateCatalogItem",
      itemId,
      title: l10n("Azumarill ex"),
      subtitle: l10n("084"),
      description: l10n("Azumarill ex from Ascended Heroes"),
    });
    await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "SetCatalogItemFieldValue",
      fieldId: setFieldId,
      value: { referenceId: setReferenceId },
    });

    await drainCatalogProjectionSubscriptions();

    const itemDetail = await getJson(`/api/catalog/items/${itemId}`);
    expect(itemDetail.response.status).toBe(200);
    expect(itemDetail.json.field_values[0]).toMatchObject({
      fieldId: setFieldId,
      fieldName: "Set",
      value: { referenceId: setReferenceId },
      reference: {
        referenceId: setReferenceId,
        typeKey: "set",
        key: "ascended-heroes",
        name: "Ascended Heroes",
        attributes: {
          "card-count": 217,
          "release-date": "2026-01-30",
          abbreviation: "ASC",
          "source-id": "me02.5",
        },
        relationships: [
          {
            relationshipType: "part-of-series",
            referenceId: seriesReferenceId,
            reference: {
              referenceId: seriesReferenceId,
              typeKey: "series",
              key: "mega-evolution",
              name: "Mega Evolution",
            },
          },
        ],
      },
    });

    await sendCommand(
      services.referenceData.referenceRecordCommandHandler,
      `catalog.reference-record-${setReferenceId}`,
      {
        type: "ReviseReferenceRecord",
        typeKey: "set",
        key: "ascended-heroes",
        name: l10n("Ascended Heroes"),
        description: l10n("Ascended Heroes set"),
        attributes: {
          "card-count": 218,
          "release-date": "2026-01-30",
          abbreviation: "ASC",
          "source-id": "me02.5",
        },
        relationships: [
          {
            relationshipType: "part-of-series",
            referenceId: seriesReferenceId,
          },
        ],
      },
    );

    await drainCatalogProjectionSubscriptions();

    const updatedItemDetail = await getJson(`/api/catalog/items/${itemId}`);
    expect(updatedItemDetail.json.field_values[0].reference.attributes["card-count"]).toBe(218);

    await sendCommand(
      services.referenceData.referenceRecordCommandHandler,
      `catalog.reference-record-${seriesReferenceId}`,
      {
        type: "ReviseReferenceRecord",
        typeKey: "series",
        key: "mega-evolution",
        name: l10n("Mega Evolution Era"),
        description: l10n("Mega Evolution series"),
        attributes: {},
        relationships: [],
      },
    );

    await drainCatalogProjectionSubscriptions();

    const updatedSeriesRelationship = await getJson(`/api/catalog/items/${itemId}`);
    expect(updatedSeriesRelationship.json.field_values[0].reference.relationships[0].reference.name).toBe(
      "Mega Evolution Era",
    );
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
      name: l10n("Form"),
      description: l10n("Card form"),
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${formDimensionId}`, {
      type: "AddOption",
      optionId: formRawOptionId,
      code: "raw",
      label: l10n("Raw"),
      numericValue: null,
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${formDimensionId}`, {
      type: "ActivateDimension",
    });

    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${conditionDimensionId}`, {
      type: "CreateDimension",
      dimensionId: conditionDimensionId,
      key: "condition",
      name: l10n("Condition"),
      description: l10n("Card condition"),
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${conditionDimensionId}`, {
      type: "AddOption",
      optionId: conditionOptionId,
      code: "near-mint",
      label: l10n("Near Mint"),
      numericValue: null,
    });
    await sendCommand(services.dimensions.commandHandler, `catalog.dimension-${conditionDimensionId}`, {
      type: "ActivateDimension",
    });

    await sendCommand(services.components.commandHandler, `catalog.component-${componentId}`, {
      type: "CreateComponent",
      componentId,
      key: "single-card-product-resolution",
      name: l10n("Single Card Product Resolution"),
      description: l10n("Product resolution rules"),
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
    await sendCommand(services.components.commandHandler, `catalog.component-${componentId}`, {
      type: "ActivateComponent",
    });

    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "CreateBlueprint",
      blueprintId,
      key: "pokemon-card-single",
      name: l10n("Pokemon Card Single"),
      description: l10n("Card blueprint"),
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
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "PublishBlueprint",
    });

    await drainCatalogProjectionSubscriptions();

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

  it("recovers one stale winning-template identity at publication and converges the admin snapshot", async () => {
    const blueprintId = "bpr_template_drift";
    const displayTemplateId = "dtp_template_drift";
    const itemId = "cat_template_drift";
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "CreateBlueprint",
      blueprintId,
      key: "template-drift",
      name: l10n("Template drift"),
      description: l10n("Template drift test"),
    });
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "PublishBlueprint",
    });
    await drainCatalogProjectionSubscriptions();
    await sendCommand(services.displayTemplates.commandHandler, `catalog.display-template-${displayTemplateId}`, {
      type: "CreateDisplayTemplate",
      displayTemplateId,
      key: "template-drift",
      name: l10n("Template drift"),
      description: l10n("Template drift test"),
      target: { kind: "blueprint", id: blueprintId },
      priority: 10,
      titleTemplate: "First {item.title}",
      subtitleTemplate: null,
    });
    await sendCommand(services.displayTemplates.commandHandler, `catalog.display-template-${displayTemplateId}`, {
      type: "PublishDisplayTemplate",
    });
    await drainCatalogProjectionSubscriptions();
    await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "CreateCatalogItem",
      itemId,
      title: l10n("Charizard"),
      subtitle: null,
      description: l10n("Draft"),
    });
    await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "AssignBlueprintToCatalogItem",
      blueprintId,
    });
    await drainCatalogProjectionSubscriptions();

    const before = await pool.query<{ display_identity_hash: string; title: string }>(
      `SELECT display_identity_hash, title FROM catalog_item_display_identities WHERE catalog_item_id = $1`,
      [itemId],
    );
    await sendCommand(services.displayTemplates.commandHandler, `catalog.display-template-${displayTemplateId}`, {
      type: "ReviseDisplayTemplate",
      key: "template-drift",
      name: l10n("Template drift"),
      description: l10n("Template drift test"),
      target: { kind: "blueprint", id: blueprintId },
      priority: 10,
      titleTemplate: "Second {item.title}",
      subtitleTemplate: null,
    });
    await drainCatalogProjectionSubscriptions();
    const stale = await pool.query<{ display_identity_hash: string; title: string }>(
      `SELECT display_identity_hash, title FROM catalog_item_display_identities WHERE catalog_item_id = $1`,
      [itemId],
    );
    expect(stale.rows[0]).toEqual(before.rows[0]);
    const queued = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM catalog_item_display_identity_recompute_work WHERE status = 'pending'`,
    );
    expect(Number(queued.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    const published = await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
      type: "PublishCatalogItem",
      blueprintIsActive: true,
      requiredFieldIds: [],
    });
    expect(published).toMatchObject({
      state: { status: "active" },
      newEvents: [{ type: "catalog.catalog-item.published" }],
    });
    const refreshed = await pool.query<{ display_identity_hash: string; title: string }>(
      `SELECT display_identity_hash, title FROM catalog_item_display_identities WHERE catalog_item_id = $1`,
      [itemId],
    );
    expect(refreshed.rows[0]?.display_identity_hash).not.toBe(before.rows[0]?.display_identity_hash);
    expect(refreshed.rows[0]?.title).toBe("Second Charizard");
    const divergentAdmin = await pool.query<{ title: string }>(
      `SELECT title FROM catalog_admin_catalog_item_detail_pages WHERE catalog_item_id = $1`,
      [itemId],
    );
    expect(divergentAdmin.rows[0]?.title).toBe("First Charizard");
    await drainCatalogProjectionSubscriptions();
    const convergedAdmin = await pool.query<{ title: string }>(
      `SELECT title FROM catalog_admin_catalog_item_detail_pages WHERE catalog_item_id = $1`,
      [itemId],
    );
    expect(convergedAdmin.rows[0]?.title).toBe("Second Charizard");
  });

  it("bulk publishes valid source-filtered draft Catalog Items and reports invalid drafts", async () => {
    const fieldId = "fld_card_name";
    const blueprintId = "bpr_imported_card";
    const validItemId = "cat_import_valid";
    const invalidItemId = "cat_import_invalid";

    await sendCommand(services.fields.commandHandler, `catalog.field-${fieldId}`, {
      type: "CreateField",
      fieldId,
      key: "card-name",
      name: l10n("Card Name"),
      description: l10n("Printed card name"),
      valueType: "localized_text",
      behavior: { filterable: true, searchable: true, sortable: true },
    });
    await sendCommand(services.fields.commandHandler, `catalog.field-${fieldId}`, { type: "ActivateField" });

    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "CreateBlueprint",
      blueprintId,
      key: "imported-card",
      name: l10n("Imported Card"),
      description: l10n("Imported card template"),
    });
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "SetBlueprintFields",
      fieldRules: [{ fieldId, required: true }],
    });
    await sendCommand(services.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "PublishBlueprint",
    });
    await drainCatalogProjectionSubscriptions();
    const displayTemplateId = "dtp_imported_card";
    await sendCommand(services.displayTemplates.commandHandler, `catalog.display-template-${displayTemplateId}`, {
      type: "CreateDisplayTemplate",
      displayTemplateId,
      key: "imported-card",
      name: l10n("Imported card"),
      description: l10n("Imported card publication identity"),
      target: { kind: "blueprint", id: blueprintId },
      priority: 10,
      titleTemplate: "{item.title}",
      subtitleTemplate: null,
    });
    await sendCommand(services.displayTemplates.commandHandler, `catalog.display-template-${displayTemplateId}`, {
      type: "PublishDisplayTemplate",
    });
    await drainCatalogProjectionSubscriptions();

    await Promise.all(
      [validItemId, invalidItemId].map(async (itemId) => {
        await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
          type: "CreateCatalogItem",
          itemId: itemId as never,
          title: l10n(itemId === validItemId ? "Valid Import" : "Invalid Import"),
          subtitle: null,
          description: l10n("Imported draft"),
        });
        await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
          type: "AssignBlueprintToCatalogItem",
          blueprintId,
        });
        await sendCommand(services.items.commandHandler, `catalog.item-${itemId}`, {
          type: "LinkExternalProductReference",
          providerKey: "tcgplayer",
          externalKey: itemId,
          selectedOptions: [],
        });
      }),
    );

    await sendCommand(services.items.commandHandler, `catalog.item-${validItemId}`, {
      type: "SetCatalogItemFieldValue",
      fieldId,
      value: l10n("Valid Import"),
    });

    await drainCatalogProjectionSubscriptions();

    const previewResponse = await app.fetch(
      new Request("http://catalog.test/api/catalog/items/bulk-publish/preview", {
        method: "POST",
        headers,
        body: JSON.stringify({
          selection: {
            mode: "filter",
            query: { status: "draft", source: "tcgplayer" },
          },
        }),
      }),
    );
    const preview = await previewResponse.json();

    expect(previewResponse.status).toBe(200);
    expect(preview).toMatchObject({
      mode: "filter",
      total: 2,
      ready_count: 1,
      blocked_count: 1,
    });
    expect(preview.item_ids).toEqual(expect.arrayContaining([validItemId, invalidItemId]));
    expect(
      preview.candidates.find((candidate: { catalog_item_id: string }) => candidate.catalog_item_id === invalidItemId),
    ).toMatchObject({
      outcome: "blocked",
      reason: `Missing required field values: ${fieldId}.`,
    });

    const confirmResponse = await app.fetch(
      new Request("http://catalog.test/api/catalog/items/bulk-publish/confirm", {
        method: "POST",
        headers,
        body: JSON.stringify({ itemIds: preview.item_ids }),
      }),
    );
    const job = await confirmResponse.json();

    expect(confirmResponse.status).toBe(202);
    for (let attempt = 0; attempt < preview.item_ids.length + 1; attempt += 1) {
      const processed = await services.authoringBulkJobs.processNext({
        claimOwnerId: "catalog_authoring_test",
        claimTtlMs: 60_000,
        services,
      });
      if (!processed) {
        break;
      }
    }
    const completedJob = await services.authoringBulkJobs.get(job.jobId);
    const result = completedJob?.result;
    expect(result).toMatchObject({
      total: 2,
      published_count: 1,
      failed_count: 0,
      skipped_count: 1,
    });

    await drainCatalogProjectionSubscriptions();

    const activeImports = await getJson("/api/catalog/items?status=active&source=tcgplayer&limit=5&offset=0");
    expect(activeImports.response.status).toBe(200);
    expect(activeImports.json.total).toBe(1);
    expect(activeImports.json.items[0]).toMatchObject({
      catalog_item_id: validItemId,
      status: "active",
      source_providers: ["tcgplayer"],
    });
  });
});
