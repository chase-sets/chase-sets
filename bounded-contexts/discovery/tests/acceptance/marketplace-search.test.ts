import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { module as catalogModule } from "@chase-sets/catalog";
import { module as identityModule } from "@chase-sets/identity";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import {
  bootstrapContextDatabase,
  drainContextProcesses,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { buildDiscoveryApi } from "../../api";
import { rebuildDiscoverySearchIndex } from "../../features/search/read-model/projection";
import { createDiscoveryServices } from "../../support/runtime-support/services";
import { module as discoveryModule } from "../..";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseBaseUrl ? describe : describe.skip;
const discoveryContextNames = [
  "catalog",
  "identity",
  "marketplace",
  "discovery",
] as const;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed discovery tests.");
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

let catalogServices: ReturnType<typeof catalogModule.createServices>;
let discoveryServices: ReturnType<typeof createDiscoveryServices>;
let subscriptionRunners: ReturnType<typeof resolveModuleSubscriptions>;
let app: Hono;
let pools: Readonly<
  Record<(typeof discoveryContextNames)[number], PgTransactionalPool>
>;

async function sendCommand<Command>(
  handler: (input: { streamId: string; command: Command; context: EventStoreContext }) => Promise<unknown>,
  streamId: string,
  command: Command,
) {
  return handler({ streamId, command, context });
}

function l10n(en: string, values: Record<string, string> = {}) {
  return {
    defaultLocale: "en" as const,
    values: {
      en,
      ...values,
    },
  };
}

const itemSeed = {
  dimensionId: "dim_condition",
  optionId: "chc_nm",
  fieldId: "fld_name",
  blueprintId: "bpr_card",
  categoryId: "cat_pokemon",
  itemId: "cat_charizard",
  japaneseItemId: "cat_japanese_charizard",
};

describeWithDatabase("marketplace search", () => {
  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      discoveryContextNames,
      "discovery_acceptance",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    catalogServices = catalogModule.createServices(pools.catalog, undefined);
    const identityServices = identityModule.createServices(pools.identity, undefined);
    const marketplaceServices = marketplaceModule.createServices(pools.marketplace, {
      commercialTermsResolver: createNoopCommercialTermsResolver(),
    });
    discoveryServices = createDiscoveryServices(pools.discovery);
    const mountedContexts = [
      {
        contextName: "catalog",
        module: catalogModule,
        services: catalogServices,
        pool: pools.catalog,
        projectors: catalogModule.projectors(catalogServices),
      },
      {
        contextName: "identity",
        mountRole: "source-only",
        module: identityModule,
        services: identityServices,
        pool: pools.identity,
        projectors: [],
      },
      {
        contextName: "marketplace",
        mountRole: "source-only",
        module: marketplaceModule,
        services: marketplaceServices,
        pool: pools.marketplace,
        projectors: [],
      },
      {
        contextName: "discovery",
        module: discoveryModule,
        services: discoveryServices,
        pool: pools.discovery,
        projectors: discoveryModule.projectors(discoveryServices),
      },
    ] as const;
    subscriptionRunners = resolveModuleSubscriptions(mountedContexts);
    const projectionGroups = resolveModuleProjectionGroups(
      mountedContexts,
      subscriptionRunners,
    );
    void projectionGroups;
    app = new Hono();
    app.route("/api/marketplace", buildDiscoveryApi(discoveryServices));
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
    await bootstrapContextDatabase(identityModule, pools.identity);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
    await bootstrapContextDatabase(discoveryModule, pools.discovery);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("indexes catalog facts into discovery search and item detail slices", async () => {
    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${itemSeed.dimensionId}`, {
      type: "CreateDimension",
      dimensionId: itemSeed.dimensionId as never,
      key: "condition",
      name: l10n("Condition"),
      description: l10n("Card condition"),
    });

    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${itemSeed.dimensionId}`, {
      type: "AddOption",
      optionId: itemSeed.optionId as never,
      code: "near-mint",
      label: l10n("Near Mint"),
      numericValue: null,
    });

    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${itemSeed.dimensionId}`, {
      type: "ActivateDimension",
    });

    await sendCommand(catalogServices.fields.commandHandler, `catalog.field-${itemSeed.fieldId}`, {
      type: "CreateField",
      fieldId: itemSeed.fieldId as never,
      key: "card-name",
      name: l10n("Card Name"),
      description: l10n("The printed card name"),
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
      name: l10n("Pokemon"),
      description: l10n("Pokemon cards"),
      displayOrder: 0,
    });

    await sendCommand(catalogServices.categories.commandHandler, `catalog.category-${itemSeed.categoryId}`, {
      type: "PublishCategory",
    });

    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${itemSeed.blueprintId}`, {
      type: "CreateBlueprint",
      blueprintId: itemSeed.blueprintId as never,
      key: "card",
      name: l10n("Pokemon Card"),
      description: l10n("A tradable card"),
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
        allowedOptionIds: [itemSeed.optionId as never],
      }],
    });

    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${itemSeed.blueprintId}`, {
      type: "SetBlueprintProductResolutionRules",
      canonicalDimensionOrder: [itemSeed.dimensionId as never],
    });

    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${itemSeed.blueprintId}`, {
      type: "PublishBlueprint",
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "CreateCatalogItem",
      itemId: itemSeed.itemId as never,
      languageCode: "en",
      title: l10n("Charizard"),
      subtitle: l10n("Base Set"),
      description: l10n("Classic fire-breathing favorite"),
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "AssignBlueprintToCatalogItem",
      blueprintId: itemSeed.blueprintId as never,
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "SetCatalogItemFieldValue",
      fieldId: itemSeed.fieldId as never,
      value: l10n("Charizard"),
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "AssignCatalogItemToCategory",
      categoryId: itemSeed.categoryId as never,
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "SetCatalogItemTags",
      tags: ["fire", "vintage"],
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "SetCatalogItemImageUrls",
      imageUrls: ["https://images.example/charizard.png"],
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.itemId}`, {
      type: "PublishCatalogItem",
      blueprintIsActive: true,
      requiredFieldIds: [itemSeed.fieldId as never],
    });

    await drainContextProcesses({
      projectors: discoveryServices.projectors,
      subscriptionRunners,
    });

    const searchResponse = await app.request("/api/marketplace/items?search=charizard&includeTotal=true");
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

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.japaneseItemId}`, {
      type: "CreateCatalogItem",
      itemId: itemSeed.japaneseItemId as never,
      languageCode: "ja",
      title: l10n("Charizard", { ja: "リザードン" }),
      subtitle: l10n("Japanese Base Set"),
      description: l10n("Japanese printed Charizard"),
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.japaneseItemId}`, {
      type: "AssignBlueprintToCatalogItem",
      blueprintId: itemSeed.blueprintId as never,
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.japaneseItemId}`, {
      type: "SetCatalogItemFieldValue",
      fieldId: itemSeed.fieldId as never,
      value: "リザードン",
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.japaneseItemId}`, {
      type: "AssignCatalogItemToCategory",
      categoryId: itemSeed.categoryId as never,
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemSeed.japaneseItemId}`, {
      type: "PublishCatalogItem",
      blueprintIsActive: true,
      requiredFieldIds: [itemSeed.fieldId as never],
    });

    await drainContextProcesses({
      projectors: discoveryServices.projectors,
      subscriptionRunners,
    });

    const japaneseSearchResponse = await app.request("/api/marketplace/items?search=%E3%83%AA%E3%82%B6%E3%83%BC%E3%83%89%E3%83%B3&includeTotal=true");
    expect(japaneseSearchResponse.status).toBe(200);
    const japaneseSearchBody = await japaneseSearchResponse.json();
    expect(japaneseSearchBody.total).toBe(1);
    expect(japaneseSearchBody.items[0].catalog_item_id).toBe(itemSeed.japaneseItemId);
    expect(japaneseSearchBody.items[0].language_code).toBe("ja");

    const languageFilterResponse = await app.request("/api/marketplace/items?language=ja");
    expect(languageFilterResponse.status).toBe(200);
    const languageFilterBody = await languageFilterResponse.json();
    expect(languageFilterBody.items.map((item: { catalog_item_id: string }) => item.catalog_item_id)).toEqual([
      itemSeed.japaneseItemId,
    ]);
  });

  it("projects conditional product resolution rules and sealed products into item detail payloads", async () => {
    const ids = {
      categoryId: "cat_pokemon",
      formDimensionId: "dim_form",
      formRawOptionId: "chc_form_raw",
      conditionDimensionId: "dim_condition",
      conditionNearMintOptionId: "chc_condition_nm",
      conditionExcellentOptionId: "chc_condition_excellent",
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
      name: l10n("Pokemon"),
      description: l10n("Pokemon items"),
      displayOrder: 0,
    });
    await sendCommand(catalogServices.categories.commandHandler, `catalog.category-${ids.categoryId}`, {
      type: "PublishCategory",
    });

    for (const field of [
      { fieldId: ids.nameFieldId, key: "card-name", name: "Card Name", valueType: "localized_text" as const },
      { fieldId: ids.setFieldId, key: "set-name", name: "Set Name", valueType: "string" as const },
      { fieldId: ids.packCountFieldId, key: "pack-count", name: "Pack Count", valueType: "number" as const },
    ]) {
      await sendCommand(catalogServices.fields.commandHandler, `catalog.field-${field.fieldId}`, {
        type: "CreateField",
        fieldId: field.fieldId as never,
        key: field.key,
        name: l10n(field.name),
        description: l10n(field.name),
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
      name: l10n("Form"),
      description: l10n("Card form"),
    });
    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${ids.formDimensionId}`, {
      type: "AddOption",
      optionId: ids.formRawOptionId as never,
      code: "raw",
      label: l10n("Raw"),
      numericValue: null,
    });
    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${ids.formDimensionId}`, {
      type: "ActivateDimension",
    });

    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${ids.conditionDimensionId}`, {
      type: "CreateDimension",
      dimensionId: ids.conditionDimensionId as never,
      key: "condition",
      name: l10n("Condition"),
      description: l10n("Card condition"),
      valueKind: "ordered",
    });
    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${ids.conditionDimensionId}`, {
      type: "AddOption",
      optionId: ids.conditionNearMintOptionId as never,
      code: "near-mint",
      label: l10n("Near Mint"),
      numericValue: 5,
    });
    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${ids.conditionDimensionId}`, {
      type: "AddOption",
      optionId: ids.conditionExcellentOptionId as never,
      code: "excellent",
      label: l10n("Excellent"),
      numericValue: 4,
    });
    await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${ids.conditionDimensionId}`, {
      type: "ActivateDimension",
    });

    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.cardBlueprintId}`, {
      type: "CreateBlueprint",
      blueprintId: ids.cardBlueprintId as never,
      key: "pokemon-card-single",
      name: l10n("Pokemon Card Single"),
      description: l10n("Single card blueprint"),
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
        { dimensionId: ids.formDimensionId as never, required: true, allowedOptionIds: [ids.formRawOptionId as never] },
        {
          dimensionId: ids.conditionDimensionId as never,
          required: true,
          allowedOptionIds: [ids.conditionExcellentOptionId as never, ids.conditionNearMintOptionId as never],
          appliesWhen: [{ dimensionId: ids.formDimensionId as never, optionIds: [ids.formRawOptionId as never] }],
        },
      ],
    });
    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.cardBlueprintId}`, {
      type: "SetBlueprintProductResolutionRules",
      canonicalDimensionOrder: [ids.formDimensionId as never, ids.conditionDimensionId as never],
    });
    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.cardBlueprintId}`, {
      type: "PublishBlueprint",
    });

    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.sealedBlueprintId}`, {
      type: "CreateBlueprint",
      blueprintId: ids.sealedBlueprintId as never,
      key: "pokemon-sealed-product",
      name: l10n("Pokemon Sealed Product"),
      description: l10n("Sealed product blueprint"),
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
      type: "SetBlueprintProductResolutionRules",
      canonicalDimensionOrder: [],
    });
    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${ids.sealedBlueprintId}`, {
      type: "PublishBlueprint",
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.cardItemId}`, {
      type: "CreateCatalogItem",
      itemId: ids.cardItemId as never,
      title: l10n("Charizard"),
      subtitle: l10n("Base Set 4/102"),
      description: l10n("Classic single"),
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.cardItemId}`, {
      type: "AssignBlueprintToCatalogItem",
      blueprintId: ids.cardBlueprintId as never,
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.cardItemId}`, {
      type: "SetCatalogItemFieldValue",
      fieldId: ids.nameFieldId as never,
      value: l10n("Charizard"),
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.cardItemId}`, {
      type: "SetCatalogItemFieldValue",
      fieldId: ids.setFieldId as never,
      value: "Base Set",
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.cardItemId}`, {
      type: "AssignCatalogItemToCategory",
      categoryId: ids.categoryId as never,
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.cardItemId}`, {
      type: "PublishCatalogItem",
      blueprintIsActive: true,
      requiredFieldIds: [ids.nameFieldId as never, ids.setFieldId as never],
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.sealedItemId}`, {
      type: "CreateCatalogItem",
      itemId: ids.sealedItemId as never,
      title: l10n("Twilight Masquerade ETB"),
      subtitle: l10n("Sealed product"),
      description: l10n("Sealed product"),
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.sealedItemId}`, {
      type: "AssignBlueprintToCatalogItem",
      blueprintId: ids.sealedBlueprintId as never,
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.sealedItemId}`, {
      type: "SetCatalogItemFieldValue",
      fieldId: ids.setFieldId as never,
      value: "Twilight Masquerade",
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.sealedItemId}`, {
      type: "SetCatalogItemFieldValue",
      fieldId: ids.packCountFieldId as never,
      value: 9,
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.sealedItemId}`, {
      type: "AssignCatalogItemToCategory",
      categoryId: ids.categoryId as never,
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${ids.sealedItemId}`, {
      type: "PublishCatalogItem",
      blueprintIsActive: true,
      requiredFieldIds: [ids.setFieldId as never, ids.packCountFieldId as never],
    });

    await drainContextProcesses({
      projectors: discoveryServices.projectors,
      subscriptionRunners,
    });

    const cardResponse = await app.request(`/api/marketplace/items/${ids.cardItemId}`);
    expect(cardResponse.status).toBe(200);
    const cardBody = await cardResponse.json();
    expect(
      cardBody.product_schema.dimensions.find((dimension: { dimensionId: string }) => dimension.dimensionId === ids.conditionDimensionId),
    ).toMatchObject({
      valueKind: "ordered",
      appliesWhen: [{ dimensionId: ids.formDimensionId, optionIds: [ids.formRawOptionId] }],
      allowedOptions: [
        { optionId: ids.conditionNearMintOptionId, displayOrder: 0, numericValue: 5 },
        { optionId: ids.conditionExcellentOptionId, displayOrder: 1, numericValue: 4 },
      ],
    });

    const sealedResponse = await app.request(`/api/marketplace/items/${ids.sealedItemId}`);
    expect(sealedResponse.status).toBe(200);
    const sealedBody = await sealedResponse.json();
    expect(sealedBody.product_schema).toMatchObject({
      canonicalDimensionOrder: [],
      dimensions: [],
    });
  });

  it("can rebuild the search index idempotently", async () => {
    await pools.discovery.query(`INSERT INTO discovery_search_catalog_items (catalog_item_id, title, status, updated_at) VALUES ('cat_test', 'Test Card', 'active', now())`);

    await rebuildDiscoverySearchIndex(pools.discovery);
    await rebuildDiscoverySearchIndex(pools.discovery);

    const result = await pools.discovery.query(`SELECT COUNT(*) AS count FROM discovery_search_items WHERE catalog_item_id = 'cat_test'`);
    expect(Number(result.rows[0].count)).toBe(1);
  });
});
