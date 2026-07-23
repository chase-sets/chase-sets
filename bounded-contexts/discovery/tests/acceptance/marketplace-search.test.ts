import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { module as catalogModule } from "@chase-sets/catalog";
import { module as checkoutModule } from "@chase-sets/checkout";
import { module as collectionsModule } from "@chase-sets/collections";
import { module as identityModule } from "@chase-sets/identity";
import { module as inventoryModule } from "@chase-sets/inventory";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { module as orderingModule } from "@chase-sets/ordering";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import {
  bootstrapContextDatabase,
  createProjectionAwarePool,
  drainContextProcesses,
  rebuildContextProjectionGroup,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
} from "@chase-sets/bounded-context-runtime";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
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
import {
  buildDiscoverySearchItemProjectionHandlers,
  rebuildDiscoverySearchIndex,
} from "../../features/search/read-model/projection";
import { createDiscoveryServices } from "../../support/runtime-support/services";
import { buildDiscoveryMarketProjectionHandlers } from "../../support/market-support/projection";
import { module as discoveryModule } from "../..";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const discoveryContextNames = [
  "catalog",
  "checkout",
  "collections",
  "identity",
  "inventory",
  "marketplace",
  "ordering",
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
let projectionGroups: ReturnType<typeof resolveModuleProjectionGroups>;
let app: Hono;
let pools: Readonly<Record<(typeof discoveryContextNames)[number], PgTransactionalPool>>;

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

describe("marketplace search", () => {
  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      discoveryContextNames,
      "discovery_acceptance",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    catalogServices = catalogModule.createServices(pools.catalog, {});
    const checkoutServices = checkoutModule.createServices(pools.checkout, {
      commercialTermsResolver: createNoopCommercialTermsResolver(),
    });
    const collectionsServices = collectionsModule.createServices(pools.collections, {});
    const identityServices = identityModule.createServices(pools.identity, {});
    const inventoryServices = inventoryModule.createServices(pools.inventory, {});
    const marketplaceServices = marketplaceModule.createServices(pools.marketplace, {
      commercialTermsResolver: createNoopCommercialTermsResolver(),
    });
    const orderingServices = orderingModule.createServices(pools.ordering, {});
    discoveryServices = createDiscoveryServices(createProjectionAwarePool(pools.discovery));
    const mountedContexts = [
      {
        contextName: "catalog",
        module: catalogModule,
        services: catalogServices,
        pool: pools.catalog,
        projectionHandlerSets: catalogModule.projectionHandlerSets?.(catalogServices) ?? [],
      },
      {
        contextName: "checkout",
        mountRole: "source-only",
        module: checkoutModule,
        services: checkoutServices,
        pool: pools.checkout,
        projectionHandlerSets: [],
      },
      {
        contextName: "collections",
        mountRole: "source-only",
        module: collectionsModule,
        services: collectionsServices,
        pool: pools.collections,
        projectionHandlerSets: [],
      },
      {
        contextName: "identity",
        mountRole: "source-only",
        module: identityModule,
        services: identityServices,
        pool: pools.identity,
        projectionHandlerSets: [],
      },
      {
        contextName: "inventory",
        mountRole: "source-only",
        module: inventoryModule,
        services: inventoryServices,
        pool: pools.inventory,
        projectionHandlerSets: [],
      },
      {
        contextName: "marketplace",
        mountRole: "source-only",
        module: marketplaceModule,
        services: marketplaceServices,
        pool: pools.marketplace,
        projectionHandlerSets: [],
      },
      {
        contextName: "ordering",
        mountRole: "source-only",
        module: orderingModule,
        services: orderingServices,
        pool: pools.ordering,
        projectionHandlerSets: [],
      },
      {
        contextName: "discovery",
        module: discoveryModule,
        services: discoveryServices,
        pool: pools.discovery,
        projectionHandlerSets: discoveryModule.projectionHandlerSets?.(discoveryServices) ?? [],
      },
    ] as const;
    subscriptionRunners = resolveModuleSubscriptions(mountedContexts);
    projectionGroups = resolveModuleProjectionGroups(mountedContexts, subscriptionRunners);
    app = new Hono();
    app.route("/api/marketplace", buildDiscoveryApi(discoveryServices));
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
    await bootstrapContextDatabase(checkoutModule, pools.checkout);
    await bootstrapContextDatabase(collectionsModule, pools.collections);
    await bootstrapContextDatabase(identityModule, pools.identity);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
    await bootstrapContextDatabase(orderingModule, pools.ordering);
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
      dimensionRules: [
        {
          dimensionId: itemSeed.dimensionId as never,
          required: true,
          allowedOptionIds: [itemSeed.optionId as never],
        },
      ],
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
      subscriptionRunners,
    });

    const searchResponse = await app.request("/api/marketplace/items?search=charizard&includeTotal=true");
    expect(searchResponse.status).toBe(200);
    const searchBody = await searchResponse.json();
    expect(searchBody.total).toBe(1);
    expect(searchBody.items[0].title).toBe("Charizard");
    expect(searchBody.facets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: itemSeed.dimensionId,
          kind: "dimension",
          label: "Condition",
          values: expect.arrayContaining([
            expect.objectContaining({
              id: itemSeed.optionId,
              label: "Near Mint",
              count: 1,
            }),
          ]),
        }),
        expect.objectContaining({
          id: itemSeed.fieldId,
          kind: "field",
          label: "Card Name",
          values: expect.arrayContaining([
            expect.objectContaining({
              id: "charizard",
              label: "Charizard",
              count: 1,
            }),
          ]),
        }),
      ]),
    );

    const fieldFilterResponse = await app.request(
      `/api/marketplace/items?field.${itemSeed.fieldId}=charizard&includeTotal=true`,
    );
    expect(fieldFilterResponse.status).toBe(200);
    const fieldFilterBody = await fieldFilterResponse.json();
    expect(fieldFilterBody.total).toBe(1);
    expect(fieldFilterBody.items[0].catalog_item_id).toBe(itemSeed.itemId);
    expect(
      fieldFilterBody.facets
        .find((facet: { id: string }) => facet.id === itemSeed.fieldId)
        .values.find((value: { id: string }) => value.id === "charizard").selected,
    ).toBe(true);

    const dimensionFilterResponse = await app.request(
      `/api/marketplace/items?dimension.${itemSeed.dimensionId}=${itemSeed.optionId}&includeTotal=true`,
    );
    expect(dimensionFilterResponse.status).toBe(200);
    const dimensionFilterBody = await dimensionFilterResponse.json();
    expect(dimensionFilterBody.total).toBe(1);
    expect(dimensionFilterBody.items[0].catalog_item_id).toBe(itemSeed.itemId);
    expect(
      dimensionFilterBody.facets
        .find((facet: { id: string }) => facet.id === itemSeed.dimensionId)
        .values.find((value: { id: string }) => value.id === itemSeed.optionId).selected,
    ).toBe(true);

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
      subscriptionRunners,
    });

    const japaneseSearchResponse = await app.request(
      "/api/marketplace/items?search=%E3%83%AA%E3%82%B6%E3%83%BC%E3%83%89%E3%83%B3&includeTotal=true",
    );
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

  it("indexes hierarchical reference data for search, facets, and item detail", async () => {
    const expansionFieldId = "fld_expansion";
    const blueprintId = "bpr_reference_card";
    const itemId = "cat_azumarill_ex";
    const manufacturerReferenceId = "ref_pokemon_company";
    const productLineReferenceId = "ref_pokemon_tcg";
    const seriesReferenceId = "ref_mega_evolution";
    const expansionReferenceId = "ref_ascended_heroes";

    await sendCommand(
      catalogServices.referenceData.referenceRecordCommandHandler,
      `catalog.reference-record-${manufacturerReferenceId}`,
      {
        type: "CreateReferenceRecord",
        referenceRecordId: manufacturerReferenceId as never,
        typeKey: "manufacturer",
        key: "pokemon-company",
        name: l10n("The Pokemon Company"),
        attributes: {},
        relationships: [],
      },
    );
    await sendCommand(
      catalogServices.referenceData.referenceRecordCommandHandler,
      `catalog.reference-record-${productLineReferenceId}`,
      {
        type: "CreateReferenceRecord",
        referenceRecordId: productLineReferenceId as never,
        typeKey: "product-line",
        key: "pokemon-tcg",
        name: l10n("Pokemon TCG"),
        attributes: {},
        relationships: [{ relationshipType: "manufacturer", referenceId: manufacturerReferenceId as never }],
      },
    );
    await sendCommand(
      catalogServices.referenceData.referenceRecordCommandHandler,
      `catalog.reference-record-${seriesReferenceId}`,
      {
        type: "CreateReferenceRecord",
        referenceRecordId: seriesReferenceId as never,
        typeKey: "series",
        key: "mega-evolution",
        name: l10n("Mega Evolution"),
        attributes: {},
        relationships: [{ relationshipType: "part-of", referenceId: productLineReferenceId as never }],
      },
    );
    await sendCommand(
      catalogServices.referenceData.referenceRecordCommandHandler,
      `catalog.reference-record-${expansionReferenceId}`,
      {
        type: "CreateReferenceRecord",
        referenceRecordId: expansionReferenceId as never,
        typeKey: "expansion",
        key: "ascended-heroes",
        name: l10n("Ascended Heroes"),
        attributes: {
          "card-count": 217,
          "release-date": "2026-01-30",
          abbr: "ASC",
          "source-id": "me02.5",
        },
        relationships: [{ relationshipType: "part-of-series", referenceId: seriesReferenceId as never }],
      },
    );

    await sendCommand(catalogServices.fields.commandHandler, `catalog.field-${expansionFieldId}`, {
      type: "CreateField",
      fieldId: expansionFieldId as never,
      key: "expansion",
      name: l10n("Expansion"),
      description: l10n("Card expansion"),
      valueType: "reference",
      behavior: { filterable: true, searchable: true, sortable: false },
    });
    await sendCommand(catalogServices.fields.commandHandler, `catalog.field-${expansionFieldId}`, {
      type: "ActivateField",
    });

    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "CreateBlueprint",
      blueprintId: blueprintId as never,
      key: "reference-card",
      name: l10n("Reference Card"),
      description: l10n("Reference-enriched card"),
    });
    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "SetBlueprintFields",
      fieldRules: [{ fieldId: expansionFieldId as never, required: true }],
    });
    await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${blueprintId}`, {
      type: "PublishBlueprint",
    });

    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemId}`, {
      type: "CreateCatalogItem",
      itemId: itemId as never,
      title: l10n("Azumarill ex"),
      subtitle: l10n("084"),
      description: l10n("Azumarill ex card"),
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemId}`, {
      type: "AssignBlueprintToCatalogItem",
      blueprintId: blueprintId as never,
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemId}`, {
      type: "SetCatalogItemFieldValue",
      fieldId: expansionFieldId as never,
      value: { referenceId: expansionReferenceId },
    });
    await sendCommand(catalogServices.items.commandHandler, `catalog.item-${itemId}`, {
      type: "PublishCatalogItem",
      blueprintIsActive: true,
      requiredFieldIds: [expansionFieldId as never],
    });

    await drainContextProcesses({
      subscriptionRunners,
    });

    const seriesSearchResponse = await app.request("/api/marketplace/items?search=mega%20evolution&includeTotal=true");
    expect(seriesSearchResponse.status).toBe(200);
    const seriesSearchBody = await seriesSearchResponse.json();
    expect(seriesSearchBody.total).toBe(1);
    expect(seriesSearchBody.items[0].catalog_item_id).toBe(itemId);

    const productLineSearchResponse = await app.request(
      "/api/marketplace/items?search=pokemon%20tcg&includeTotal=true",
    );
    expect(productLineSearchResponse.status).toBe(200);
    const productLineSearchBody = await productLineSearchResponse.json();
    expect(productLineSearchBody.total).toBe(1);
    expect(productLineSearchBody.items[0].catalog_item_id).toBe(itemId);

    expect(productLineSearchBody.facets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "expansion",
          kind: "reference",
          label: "Expansion",
          values: expect.arrayContaining([
            expect.objectContaining({
              id: expansionReferenceId,
              label: "Ascended Heroes",
              count: 1,
            }),
          ]),
        }),
        expect.objectContaining({
          id: "series",
          kind: "reference",
          label: "Series",
          values: expect.arrayContaining([
            expect.objectContaining({
              id: seriesReferenceId,
              label: "Mega Evolution",
              count: 1,
            }),
          ]),
        }),
        expect.objectContaining({
          id: "product-line",
          kind: "reference",
          label: "Product Line",
          values: expect.arrayContaining([
            expect.objectContaining({
              id: productLineReferenceId,
              label: "Pokemon TCG",
              count: 1,
            }),
          ]),
        }),
      ]),
    );

    const expansionFilterResponse = await app.request(
      `/api/marketplace/items?field.${expansionFieldId}=${expansionReferenceId}&includeTotal=true`,
    );
    expect(expansionFilterResponse.status).toBe(200);
    const expansionFilterBody = await expansionFilterResponse.json();
    expect(expansionFilterBody.total).toBe(1);
    expect(expansionFilterBody.items[0].catalog_item_id).toBe(itemId);

    const seriesFilterResponse = await app.request(
      `/api/marketplace/items?field.${expansionFieldId}:series=${seriesReferenceId}&includeTotal=true`,
    );
    expect(seriesFilterResponse.status).toBe(200);
    const seriesFilterBody = await seriesFilterResponse.json();
    expect(seriesFilterBody.total).toBe(1);
    expect(seriesFilterBody.items[0].catalog_item_id).toBe(itemId);

    const referenceExpansionFilterResponse = await app.request(
      `/api/marketplace/items?reference.expansion=${expansionReferenceId}&includeTotal=true`,
    );
    expect(referenceExpansionFilterResponse.status).toBe(200);
    const referenceExpansionFilterBody = await referenceExpansionFilterResponse.json();
    expect(referenceExpansionFilterBody.total).toBe(1);
    expect(referenceExpansionFilterBody.items[0].catalog_item_id).toBe(itemId);
    expect(
      referenceExpansionFilterBody.facets
        .find((facet: { id: string; kind: string }) => facet.id === "expansion" && facet.kind === "reference")
        .values.find((value: { id: string }) => value.id === expansionReferenceId).selected,
    ).toBe(true);

    const referenceSeriesFilterResponse = await app.request(
      `/api/marketplace/items?reference.series=${seriesReferenceId}&includeTotal=true`,
    );
    expect(referenceSeriesFilterResponse.status).toBe(200);
    const referenceSeriesFilterBody = await referenceSeriesFilterResponse.json();
    expect(referenceSeriesFilterBody.total).toBe(1);
    expect(referenceSeriesFilterBody.items[0].catalog_item_id).toBe(itemId);

    const referenceProductLineFilterResponse = await app.request(
      `/api/marketplace/items?reference.product-line=${productLineReferenceId}&includeTotal=true`,
    );
    expect(referenceProductLineFilterResponse.status).toBe(200);
    const referenceProductLineFilterBody = await referenceProductLineFilterResponse.json();
    expect(referenceProductLineFilterBody.total).toBe(1);
    expect(referenceProductLineFilterBody.items[0].catalog_item_id).toBe(itemId);

    const detailResponse = await app.request(`/api/marketplace/items/${itemId}`);
    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json();
    expect(detailBody.field_values[0].reference).toMatchObject({
      referenceId: expansionReferenceId,
      name: "Ascended Heroes",
      attributes: { "card-count": 217, abbr: "ASC" },
      relationships: [
        {
          relationshipType: "part-of-series",
          reference: {
            referenceId: seriesReferenceId,
            name: "Mega Evolution",
            relationships: [
              {
                relationshipType: "part-of",
                reference: {
                  referenceId: productLineReferenceId,
                  name: "Pokemon TCG",
                  relationships: [
                    {
                      relationshipType: "manufacturer",
                      reference: {
                        referenceId: manufacturerReferenceId,
                        name: "The Pokemon Company",
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });

    await sendCommand(
      catalogServices.referenceData.referenceRecordCommandHandler,
      `catalog.reference-record-${productLineReferenceId}`,
      {
        type: "ReviseReferenceRecord",
        typeKey: "product-line",
        key: "pokemon-tcg",
        name: l10n("Pokemon Trading Card Game"),
        attributes: {},
        relationships: [{ relationshipType: "manufacturer", referenceId: manufacturerReferenceId as never }],
      },
    );

    await drainContextProcesses({
      subscriptionRunners,
    });

    const updatedSearchResponse = await app.request(
      "/api/marketplace/items?search=trading%20card%20game&includeTotal=true",
    );
    expect(updatedSearchResponse.status).toBe(200);
    const updatedSearchBody = await updatedSearchResponse.json();
    expect(updatedSearchBody.total).toBe(1);
    expect(updatedSearchBody.items[0].catalog_item_id).toBe(itemId);
  });

  it("projects conditional product resolution rules and sealed products into item detail payloads", async () => {
    const ids = {
      categoryId: "cat_pokemon",
      formDimensionId: "dim_form",
      formRawOptionId: "chc_form_raw",
      conditionDimensionId: "dim_condition",
      conditionPristineOptionId: "chc_condition_pristine",
      conditionMintOptionId: "chc_condition_mint",
      conditionNearMintOptionId: "chc_condition_near_mint",
      conditionExcellentOptionId: "chc_condition_excellent",
      conditionGoodOptionId: "chc_condition_good",
      conditionPoorOptionId: "chc_condition_poor",
      conditionDamagedOptionId: "chc_condition_damaged",
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
    for (const option of [
      { optionId: ids.conditionPristineOptionId, code: "pristine", label: "Pristine", numericValue: 7 },
      { optionId: ids.conditionMintOptionId, code: "mint", label: "Mint", numericValue: 6 },
      { optionId: ids.conditionNearMintOptionId, code: "near-mint", label: "Near Mint", numericValue: 5 },
      { optionId: ids.conditionExcellentOptionId, code: "excellent", label: "Excellent", numericValue: 4 },
      { optionId: ids.conditionGoodOptionId, code: "good", label: "Good", numericValue: 3 },
      { optionId: ids.conditionPoorOptionId, code: "poor", label: "Poor", numericValue: 2 },
      { optionId: ids.conditionDamagedOptionId, code: "damaged", label: "Damaged", numericValue: 1 },
    ]) {
      await sendCommand(catalogServices.dimensions.commandHandler, `catalog.dimension-${ids.conditionDimensionId}`, {
        type: "AddOption",
        optionId: option.optionId as never,
        code: option.code,
        label: l10n(option.label),
        numericValue: option.numericValue,
      });
    }
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
          allowedOptionIds: [
            ids.conditionDamagedOptionId as never,
            ids.conditionExcellentOptionId as never,
            ids.conditionGoodOptionId as never,
            ids.conditionMintOptionId as never,
            ids.conditionNearMintOptionId as never,
            ids.conditionPoorOptionId as never,
            ids.conditionPristineOptionId as never,
          ],
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
      subscriptionRunners,
    });

    const cardResponse = await app.request(`/api/marketplace/items/${ids.cardItemId}`);
    expect(cardResponse.status).toBe(200);
    const cardBody = await cardResponse.json();
    const cardConditionDimension = cardBody.product_schema.dimensions.find(
      (dimension: { dimensionId: string }) => dimension.dimensionId === ids.conditionDimensionId,
    );
    expect(cardConditionDimension).toMatchObject({
      valueKind: "ordered",
      appliesWhen: [{ dimensionId: ids.formDimensionId, optionIds: [ids.formRawOptionId] }],
      allowedOptions: [
        { optionId: ids.conditionPristineOptionId, displayOrder: 0, numericValue: 7 },
        { optionId: ids.conditionMintOptionId, displayOrder: 1, numericValue: 6 },
        { optionId: ids.conditionNearMintOptionId, displayOrder: 2, numericValue: 5 },
        { optionId: ids.conditionExcellentOptionId, displayOrder: 3, numericValue: 4 },
        { optionId: ids.conditionGoodOptionId, displayOrder: 4, numericValue: 3 },
        { optionId: ids.conditionPoorOptionId, displayOrder: 5, numericValue: 2 },
        { optionId: ids.conditionDamagedOptionId, displayOrder: 6, numericValue: 1 },
      ],
    });

    const searchResponse = await app.request("/api/marketplace/items?includeTotal=true");
    expect(searchResponse.status).toBe(200);
    const searchBody = await searchResponse.json();
    const searchConditionFacet = searchBody.facets.find(
      (facet: { id: string }) => facet.id === ids.conditionDimensionId,
    );
    expect(searchConditionFacet.values.map((value: { label: string }) => value.label)).toEqual(
      cardConditionDimension.allowedOptions.map((option: { label: string }) => option.label),
    );

    const sealedResponse = await app.request(`/api/marketplace/items/${ids.sealedItemId}`);
    expect(sealedResponse.status).toBe(200);
    const sealedBody = await sealedResponse.json();
    expect(sealedBody.product_schema).toMatchObject({
      canonicalDimensionOrder: [],
      dimensions: [],
    });
  });

  it("can rebuild the search index idempotently", async () => {
    await pools.discovery.query(
      `INSERT INTO discovery_search_catalog_items (catalog_item_id, title, display_badges, status, updated_at)
       VALUES (
         'cat_test',
         'Test Card',
         '[{"kind":"rarity","label":"Rare"},{"kind":"number","label":"7/100"}]'::jsonb,
         'active',
         now()
       )`,
    );

    await rebuildDiscoverySearchIndex(pools.discovery);
    const firstBuild = await loadSearchIndexRow("cat_test");
    await rebuildDiscoverySearchIndex(pools.discovery);
    const secondBuild = await loadSearchIndexRow("cat_test");

    const result = await pools.discovery.query<{ count: string; display_badges: unknown }>(
      `SELECT display_badges, COUNT(*) OVER()::text AS count
       FROM discovery_search_items
       WHERE catalog_item_id = 'cat_test'`,
    );
    expect(Number(result.rows[0].count)).toBe(1);
    expect(result.rows[0].display_badges).toEqual([
      { kind: "rarity", label: "Rare" },
      { kind: "number", label: "7/100" },
    ]);
    expect(secondBuild).toEqual(firstBuild);
  });

  it("keeps serving the active Search Index while a complete shadow waits for cutover", async () => {
    await pools.discovery.query(
      `INSERT INTO discovery_search_catalog_items (catalog_item_id, title, status, updated_at)
       VALUES ('cat_serving', 'Serving Card', 'active', '2026-07-23T01:00:00.000Z')`,
    );
    await rebuildDiscoverySearchIndex(pools.discovery);
    await pools.discovery.query(
      `INSERT INTO discovery_search_catalog_items (catalog_item_id, title, status, updated_at)
       VALUES ('cat_shadow', 'Shadow Card', 'active', '2026-07-23T01:01:00.000Z')`,
    );

    let announceShadowReady!: () => void;
    const shadowReady = new Promise<void>((resolve) => {
      announceShadowReady = resolve;
    });
    let releaseCutover!: () => void;
    const cutoverReleased = new Promise<void>((resolve) => {
      releaseCutover = resolve;
    });
    const rebuild = rebuildDiscoverySearchIndex(pools.discovery, {
      onShadowReady: async () => {
        announceShadowReady();
        await cutoverReleased;
      },
    });

    await shadowReady;
    try {
      const response = await app.request("/api/marketplace/items?search=Serving");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items.map((item: { catalog_item_id: string }) => item.catalog_item_id)).toContain("cat_serving");
    } finally {
      releaseCutover();
    }
    await rebuild;

    const response = await app.request("/api/marketplace/items?search=Shadow");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.map((item: { catalog_item_id: string }) => item.catalog_item_id)).toContain("cat_shadow");
  });

  it("converges incremental projection and rebuild to the same Search Index row", async () => {
    const handlers = buildDiscoverySearchItemProjectionHandlers(pools.discovery);
    await handlers["catalog.catalog-item.created"]?.(
      projectionEvent(
        "catalog.catalog-item.created",
        {
          itemId: "cat_converges",
          title: l10n("Convergent Card"),
          subtitle: null,
          description: l10n("Built incrementally first"),
        },
        "catalog.item-cat_converges",
        1,
      ),
    );
    await handlers["catalog.catalog-item.published"]?.(
      projectionEvent("catalog.catalog-item.published", { blueprintId: null }, "catalog.item-cat_converges", 2),
    );

    const incremental = await loadSearchIndexRow("cat_converges");
    await rebuildDiscoverySearchIndex(pools.discovery);
    expect(await loadSearchIndexRow("cat_converges")).toEqual(incremental);
  });

  it("invalidates category facets in event order and preserves the result through rebuild", async () => {
    const handlers = buildDiscoverySearchItemProjectionHandlers(pools.discovery);
    const categoryStream = "catalog.category-cat_lifecycle";
    const itemStream = "catalog.item-cat_lifecycle_item";

    await handlers["catalog.category.created"]?.(
      projectionEvent(
        "catalog.category.created",
        { categoryId: "cat_lifecycle", name: l10n("Trading Cards") },
        categoryStream,
        1,
      ),
    );
    await handlers["catalog.category.published"]?.(
      projectionEvent("catalog.category.published", {}, categoryStream, 2),
    );
    await handlers["catalog.catalog-item.created"]?.(
      projectionEvent(
        "catalog.catalog-item.created",
        {
          itemId: "cat_lifecycle_item",
          title: l10n("Lifecycle Card"),
          subtitle: null,
          description: l10n("Category lifecycle fixture"),
        },
        itemStream,
        3,
      ),
    );
    await handlers["catalog.catalog-item.published"]?.(
      projectionEvent("catalog.catalog-item.published", { blueprintId: null }, itemStream, 4),
    );
    await handlers["catalog.catalog-item.category-assigned"]?.(
      projectionEvent("catalog.catalog-item.category-assigned", { categoryId: "cat_lifecycle" }, itemStream, 5),
    );
    expect((await loadSearchIndexRow("cat_lifecycle_item"))?.category_names).toEqual(["Trading Cards"]);

    await handlers["catalog.category.revised"]?.(
      projectionEvent("catalog.category.revised", { name: l10n("Collectible Cards") }, categoryStream, 6),
    );
    expect((await loadSearchIndexRow("cat_lifecycle_item"))?.category_names).toEqual(["Collectible Cards"]);

    await handlers["catalog.category.deprecated"]?.(
      projectionEvent("catalog.category.deprecated", {}, categoryStream, 7),
    );
    expect((await loadSearchIndexRow("cat_lifecycle_item"))?.category_names).toEqual([]);

    await handlers["catalog.category.revised"]?.(
      projectionEvent("catalog.category.revised", { name: l10n("Stale Name") }, categoryStream, 6),
    );
    const category = await pools.discovery.query<{ name: string; status: string; last_global_position: string }>(
      `SELECT name, status, last_global_position::text
       FROM discovery_search_catalog_categories
       WHERE category_id = 'cat_lifecycle'`,
    );
    expect(category.rows[0]).toEqual({
      name: "Collectible Cards",
      status: "deprecated",
      last_global_position: "7",
    });

    await handlers["catalog.category.archived"]?.(projectionEvent("catalog.category.archived", {}, categoryStream, 8));
    const incremental = await loadSearchIndexRow("cat_lifecycle_item");
    expect(incremental?.category_names).toEqual([]);
    expect(incremental?.category_slugs).toEqual([]);

    await rebuildDiscoverySearchIndex(pools.discovery);
    expect(await loadSearchIndexRow("cat_lifecycle_item")).toEqual(incremental);
  });

  it("invokes the Search Index rebuild through the existing projection operation", async () => {
    await pools.discovery.query(
      `INSERT INTO discovery_search_catalog_items (catalog_item_id, title, status, updated_at)
       VALUES ('cat_operation', 'Operation Card', 'active', '2026-07-23T02:00:00.000Z')`,
    );

    await rebuildContextProjectionGroup({ projectionGroups }, "discovery", "discovery-search-item-projection");

    expect(await loadSearchIndexRow("cat_operation")).toMatchObject({
      catalog_item_id: "cat_operation",
      title: "Operation Card",
    });
  });

  it("matches Latin diacritics symmetrically for titles and aliases", async () => {
    await pools.discovery.query(
      `INSERT INTO discovery_search_catalog_items (
         catalog_item_id, title, status, resolved_aliases, updated_at
       ) VALUES
         ('cat_plain_pokemon', 'Pokemon Anniversary', 'active', '{}'::jsonb, now()),
         ('cat_accented_pokemon', 'Pokémon Celebration', 'active', '{}'::jsonb, now()),
         (
           'cat_alias_pokemon',
           'Pocket Monsters',
           'active',
           '{"en":[{"aliasHash":"alias-pokemon","aliasText":"Pokémon Legacy","normalizedAliasText":"pokémon legacy","aliasType":"official-equivalent","confidence":"high","broad":false}]}'::jsonb,
           now()
         )`,
    );
    await rebuildDiscoverySearchIndex(pools.discovery);

    const searchItemIds = async (query: string) => {
      const response = await app.request(`/api/marketplace/items?search=${encodeURIComponent(query)}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      return body.items.map((item: { catalog_item_id: string }) => item.catalog_item_id);
    };

    expect(await searchItemIds("Pokémon Anniversary")).toContain("cat_plain_pokemon");
    expect(await searchItemIds("Pokemon Celebration")).toContain("cat_accented_pokemon");
    expect(await searchItemIds("Pokemon Legacy")).toContain("cat_alias_pokemon");
  });

  it("keeps Search Index price and availability signals correct through the full listing lifecycle", async () => {
    const handlers = buildDiscoveryMarketProjectionHandlers(pools.discovery);
    let eventPosition = 1;
    const project = async (type: string, streamId: string, streamVersion: number, data: Record<string, unknown>) => {
      const handler = handlers[type];
      expect(handler).toBeDefined();
      await handler?.(
        buildTransportEvent(type, data, {
          id: `evt_market_signal_${eventPosition}`,
          streamId,
          streamVersion,
          globalPosition: String(eventPosition++),
          tenantId: "tnt_test",
          audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
          timing: {
            occurredAt: `2026-07-14T00:00:${String(eventPosition).padStart(2, "0")}.000Z`,
            recordedAt: `2026-07-14T00:00:${String(eventPosition).padStart(2, "0")}.000Z`,
          },
        }),
      );
    };
    const signals = async () => {
      const result = await pools.discovery.query<{
        lowest_price_amount: string | null;
        visible_quantity: number | null;
      }>(
        `SELECT lowest_price_amount::text AS lowest_price_amount, visible_quantity
         FROM discovery_search_items
         WHERE catalog_item_id = 'cat_market_signal'`,
      );
      return result.rows[0];
    };

    await pools.discovery.query(
      `INSERT INTO discovery_search_catalog_items (catalog_item_id, title, status)
       VALUES ('cat_market_signal', 'Market Signal Item', 'active')`,
    );
    await rebuildDiscoverySearchIndex(pools.discovery);
    await project("identity.account.created", "identity.account-acc_market_signal", 1, {
      accountId: "acc_market_signal",
      displayName: "Market Signal Account",
    });
    await project("inventory.item.created", "inventory.item-inv_market_signal_1", 1, {
      itemId: "inv_market_signal_1",
      accountId: "acc_market_signal",
      catalogItemId: "cat_market_signal",
      productId: "prd_market_signal_1",
      selectedOptions: [],
      storageLocationId: "loc_market_signal",
      totalQuantity: 5,
    });
    await project("marketplace.listing.created", "marketplace.listing-lst_market_signal_1", 1, {
      listingId: "lst_market_signal_1",
      accountId: "acc_market_signal",
      inventoryItemId: "inv_market_signal_1",
      catalogItemId: "cat_market_signal",
      productId: "prd_market_signal_1",
      itemTitle: "Market Signal Item",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      productMeasureSnapshot: { quantity: 1, unit: "item" },
      storageLocationName: "Test location",
      shipFromCode: "US-IL",
      priceAmount: "10.00",
      quantityCap: 4,
    });
    expect(await signals()).toEqual({ lowest_price_amount: null, visible_quantity: null });

    await project("marketplace.listing.published", "marketplace.listing-lst_market_signal_1", 2, {});
    expect(await signals()).toEqual({ lowest_price_amount: "10.00", visible_quantity: 4 });

    await project("marketplace.listing.price-updated", "marketplace.listing-lst_market_signal_1", 3, {
      priceAmount: "12.00",
    });
    expect(await signals()).toEqual({ lowest_price_amount: "12.00", visible_quantity: 4 });

    await project("inventory.hold.placed", "inventory.hold-hld_market_signal", 1, {
      holdId: "hld_market_signal",
      itemId: "inv_market_signal_1",
      quantity: 4,
    });
    expect(await signals()).toEqual({ lowest_price_amount: "12.00", visible_quantity: 1 });

    await project("marketplace.listing.quantity-cap-updated", "marketplace.listing-lst_market_signal_1", 4, {
      quantityCap: 0,
    });
    expect(await signals()).toEqual({ lowest_price_amount: null, visible_quantity: null });

    await project("marketplace.listing.quantity-cap-updated", "marketplace.listing-lst_market_signal_1", 5, {
      quantityCap: 4,
    });
    await project("inventory.hold.released", "inventory.hold-hld_market_signal", 2, {
      holdId: "hld_market_signal",
      releasedAt: "2026-07-14T00:01:00.000Z",
    });
    expect(await signals()).toEqual({ lowest_price_amount: "12.00", visible_quantity: 4 });

    await project("inventory.item.created", "inventory.item-inv_market_signal_2", 1, {
      itemId: "inv_market_signal_2",
      accountId: "acc_market_signal",
      catalogItemId: "cat_market_signal",
      productId: "prd_market_signal_2",
      selectedOptions: [],
      storageLocationId: "loc_market_signal",
      totalQuantity: 2,
    });
    await project("marketplace.listing.created", "marketplace.listing-lst_market_signal_2", 1, {
      listingId: "lst_market_signal_2",
      accountId: "acc_market_signal",
      inventoryItemId: "inv_market_signal_2",
      catalogItemId: "cat_market_signal",
      productId: "prd_market_signal_2",
      itemTitle: "Market Signal Item",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      productMeasureSnapshot: { quantity: 1, unit: "item" },
      storageLocationName: "Test location",
      shipFromCode: "US-IL",
      priceAmount: "20.00",
      quantityCap: 2,
    });
    await project("marketplace.listing.published", "marketplace.listing-lst_market_signal_2", 2, {});
    expect(await signals()).toEqual({ lowest_price_amount: "12.00", visible_quantity: 6 });

    await project(
      "marketplace.seller-listing-availability.disabled",
      "marketplace.seller-listing-availability-acc_market_signal",
      1,
      {
        accountId: "acc_market_signal",
        reasonCategory: "away",
        availableAgainOn: null,
      },
    );
    expect(await signals()).toEqual({ lowest_price_amount: null, visible_quantity: null });
    await project(
      "marketplace.seller-listing-availability.enabled",
      "marketplace.seller-listing-availability-acc_market_signal",
      2,
      { accountId: "acc_market_signal" },
    );
    expect(await signals()).toEqual({ lowest_price_amount: "12.00", visible_quantity: 6 });

    await project("marketplace.listing.paused", "marketplace.listing-lst_market_signal_1", 6, {});
    expect(await signals()).toEqual({ lowest_price_amount: "20.00", visible_quantity: 2 });
    await project("marketplace.listing.withdrawn", "marketplace.listing-lst_market_signal_2", 3, {});
    expect(await signals()).toEqual({ lowest_price_amount: null, visible_quantity: null });

    await project("marketplace.listing.published", "marketplace.listing-lst_market_signal_2", 4, {});
    expect(await signals()).toEqual({ lowest_price_amount: "20.00", visible_quantity: 2 });
    await rebuildDiscoverySearchIndex(pools.discovery);
    expect(await signals()).toEqual({ lowest_price_amount: "20.00", visible_quantity: 2 });
  });

  it("keyset-paginates both price sorts without duplicates or gaps and keeps zero-listing items last", async () => {
    await pools.discovery.query(
      `INSERT INTO discovery_search_items (
         catalog_item_id,
         title,
         status,
         lowest_price_amount,
         visible_quantity
       ) VALUES
         ('cat_price_a', 'A', 'active', 10.00, 1),
         ('cat_price_b', 'B', 'active', 10.00, 2),
         ('cat_price_c', 'C', 'active', 20.00, 3),
         ('cat_price_d', 'D', 'active', NULL, NULL),
         ('cat_price_e', 'E', 'active', NULL, NULL)`,
    );

    const readAllPages = async (sort: "price_asc" | "price_desc") => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ sort, limit: "2" });
        if (cursor) query.set("cursor", cursor);
        const response = await app.request(`/api/marketplace/items?${query.toString()}`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          items: Array<{ catalog_item_id: string }>;
          nextCursor: string | null;
        };
        ids.push(...body.items.map((item) => item.catalog_item_id));
        cursor = body.nextCursor;
      } while (cursor);
      return ids;
    };

    expect(await readAllPages("price_asc")).toEqual([
      "cat_price_a",
      "cat_price_b",
      "cat_price_c",
      "cat_price_d",
      "cat_price_e",
    ]);
    expect(await readAllPages("price_desc")).toEqual([
      "cat_price_c",
      "cat_price_b",
      "cat_price_a",
      "cat_price_e",
      "cat_price_d",
    ]);
  });

  it("combines price and in-stock filters with facet counts", async () => {
    await pools.discovery.query(
      `INSERT INTO discovery_search_items (
         catalog_item_id,
         title,
         status,
         field_filter_values,
         lowest_price_amount,
         visible_quantity
       ) VALUES
         ('cat_budget_rare', 'Budget Rare', 'active', '[{"fieldId":"rarity","label":"Rarity","value":"rare","valueLabel":"Rare"}]'::jsonb, 15.00, 1),
         ('cat_expensive_rare', 'Expensive Rare', 'active', '[{"fieldId":"rarity","label":"Rarity","value":"rare","valueLabel":"Rare"}]'::jsonb, 40.00, 1),
         ('cat_budget_common', 'Budget Common', 'active', '[{"fieldId":"rarity","label":"Rarity","value":"common","valueLabel":"Common"}]'::jsonb, 20.00, 0),
         ('cat_unlisted_rare', 'Unlisted Rare', 'active', '[{"fieldId":"rarity","label":"Rarity","value":"rare","valueLabel":"Rare"}]'::jsonb, NULL, NULL)`,
    );

    const response = await app.request("/api/marketplace/items?priceMin=10&priceMax=25&inStock=true&includeTotal=true");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      total: number;
      items: Array<{ catalog_item_id: string }>;
      facets: Array<{ id: string; values: Array<{ id: string; count: number }> }>;
    };
    expect(body.total).toBe(1);
    expect(body.items.map((item) => item.catalog_item_id)).toEqual(["cat_budget_rare"]);
    expect(body.facets.find((facet) => facet.id === "rarity")?.values).toEqual([
      expect.objectContaining({ id: "rare", count: 1 }),
    ]);
  });

  it("does not expose draft catalog items through public status params or bulk preview", async () => {
    await pools.discovery.query(
      `INSERT INTO discovery_search_catalog_items (catalog_item_id, title, status, updated_at)
       VALUES
         ('cat_public_active', 'Public Active Item', 'active', now()),
         ('cat_private_draft', 'Draft Leak Item', 'draft', now())`,
    );

    await rebuildDiscoverySearchIndex(pools.discovery);

    const searchResponse = await app.request("/api/marketplace/items?status=draft&includeTotal=true");
    expect(searchResponse.status).toBe(200);
    const searchBody = await searchResponse.json();
    expect(searchBody.total).toBe(1);
    expect(searchBody.items.map((item: { catalog_item_id: string }) => item.catalog_item_id)).toEqual([
      "cat_public_active",
    ]);
    expect(searchBody.items.every((item: { status: string }) => item.status === "active")).toBe(true);

    const archivedSearchResponse = await app.request("/api/marketplace/items?status=archived&includeTotal=true");
    expect(archivedSearchResponse.status).toBe(200);
    const archivedSearchBody = await archivedSearchResponse.json();
    expect(archivedSearchBody.items.map((item: { catalog_item_id: string }) => item.catalog_item_id)).toEqual([
      "cat_public_active",
    ]);

    const bulkResponse = await app.request("/api/marketplace/items/bulk-cart-preview?status=draft&includeTotal=true");
    expect(bulkResponse.status).toBe(200);
    const bulkBody = await bulkResponse.json();
    expect(bulkBody.lines.map((line: { catalog_item_id: string }) => line.catalog_item_id)).toEqual([
      "cat_public_active",
    ]);
  });

  it("does not match active containers by draft contained item text until the contained item is published", async () => {
    const handlers = buildDiscoverySearchItemProjectionHandlers(pools.discovery);
    await pools.discovery.query(
      `INSERT INTO discovery_search_catalog_items (catalog_item_id, language_code, title, status, updated_at)
       VALUES
         ('cat_public_container', 'en', 'Public Booster Box', 'active', now()),
         ('cat_secret_contained', 'ja', 'Secret Contained Leak', 'draft', now())`,
    );
    await rebuildDiscoverySearchIndex(pools.discovery);

    await handlers["catalog.product-contents.resolved"]?.(
      productContentsResolvedEvent({
        containerCatalogItemId: "cat_public_container",
        containedCatalogItemId: "cat_secret_contained",
      }),
    );

    const draftSearchResponse = await app.request(
      `/api/marketplace/items?language=en&search=${encodeURIComponent("Secret Contained Leak")}&includeTotal=true`,
    );
    expect(draftSearchResponse.status).toBe(200);
    const draftSearchBody = await draftSearchResponse.json();
    expect(draftSearchBody.items.map((item: { catalog_item_id: string }) => item.catalog_item_id)).not.toContain(
      "cat_public_container",
    );
    expect(draftSearchBody.total).toBe(0);

    await handlers["catalog.catalog-item.published"]?.(catalogItemPublishedEvent("cat_secret_contained"));

    const publishedSearchResponse = await app.request(
      `/api/marketplace/items?language=en&search=${encodeURIComponent("Secret Contained Leak")}&includeTotal=true`,
    );
    expect(publishedSearchResponse.status).toBe(200);
    const publishedSearchBody = await publishedSearchResponse.json();
    expect(publishedSearchBody.items.map((item: { catalog_item_id: string }) => item.catalog_item_id)).toEqual([
      "cat_public_container",
    ]);
  });

  it("matches an active container only by its contents and re-folds the tsvector when the contained item text changes", async () => {
    const handlers = buildDiscoverySearchItemProjectionHandlers(pools.discovery);
    await pools.discovery.query(
      `INSERT INTO discovery_search_catalog_items (catalog_item_id, language_code, title, status, updated_at)
       VALUES
         ('cat_fold_container', 'en', 'Grandmaster Collector Tin', 'active', now()),
         ('cat_fold_contained', 'en', 'Zephyrquux Alpha Card', 'active', now())`,
    );
    await rebuildDiscoverySearchIndex(pools.discovery);

    await handlers["catalog.product-contents.resolved"]?.(
      productContentsResolvedEvent({
        containerCatalogItemId: "cat_fold_container",
        containedCatalogItemId: "cat_fold_contained",
      }),
    );

    // The container is found by a term that appears ONLY in its contained item's
    // title, resolved purely through the folded item tsvector (no correlated EXISTS).
    // The contained item also matches the term via its own title (weight A) and,
    // because contents fold in at weight D, it correctly ranks ahead of the
    // content-only container match — preserving exact-item-before-content ordering.
    const containedTermBody = await (
      await app.request(
        `/api/marketplace/items?language=en&search=${encodeURIComponent("Zephyrquux")}&includeTotal=true`,
      )
    ).json();
    const containedTermIds = containedTermBody.items.map((item: { catalog_item_id: string }) => item.catalog_item_id);
    expect(containedTermIds).toContain("cat_fold_container");
    expect(containedTermIds).toContain("cat_fold_contained");
    expect(containedTermIds.indexOf("cat_fold_contained")).toBeLessThan(containedTermIds.indexOf("cat_fold_container"));
    expect(containedTermBody.total).toBe(2);

    // A contents change (the contained item's display identity is revised) re-folds
    // the container's tsvector against the new text.
    await handlers["catalog.catalog-item.display-identity-resolved"]?.(
      displayIdentityResolvedEvent({
        catalogItemId: "cat_fold_contained",
        title: "Wobblenaut Omega Card",
        subtitle: null,
      }),
    );

    const newTermIds = (
      await (
        await app.request(
          `/api/marketplace/items?language=en&search=${encodeURIComponent("Wobblenaut")}&includeTotal=true`,
        )
      ).json()
    ).items.map((item: { catalog_item_id: string }) => item.catalog_item_id);
    expect(newTermIds).toContain("cat_fold_container");
    expect(newTermIds).toContain("cat_fold_contained");

    // The stale contained term no longer matches the container (re-folded) nor the
    // contained item itself (renamed) after the contents change.
    const staleTermBody = await (
      await app.request(
        `/api/marketplace/items?language=en&search=${encodeURIComponent("Zephyrquux")}&includeTotal=true`,
      )
    ).json();
    expect(staleTermBody.items.map((item: { catalog_item_id: string }) => item.catalog_item_id)).not.toContain(
      "cat_fold_container",
    );
    expect(staleTermBody.total).toBe(0);
  });

  describe("Catalog alias facts in search (#1911)", () => {
    const aliasSeed = {
      categoryId: "cat_pokemon",
      blueprintId: "bpr_card",
      fieldId: "fld_name",
      englishItemId: "cat_cacnea_en",
      japaneseItemId: "cat_cacnea_ja",
    };

    async function seedAliasFixture() {
      await sendCommand(catalogServices.categories.commandHandler, `catalog.category-${aliasSeed.categoryId}`, {
        type: "CreateCategory",
        categoryId: aliasSeed.categoryId as never,
        key: "pokemon",
        name: l10n("Pokemon"),
        description: l10n("Pokemon cards"),
        displayOrder: 0,
      });
      await sendCommand(catalogServices.categories.commandHandler, `catalog.category-${aliasSeed.categoryId}`, {
        type: "PublishCategory",
      });
      await sendCommand(catalogServices.fields.commandHandler, `catalog.field-${aliasSeed.fieldId}`, {
        type: "CreateField",
        fieldId: aliasSeed.fieldId as never,
        key: "card-name",
        name: l10n("Card Name"),
        description: l10n("The printed card name"),
        valueType: "string",
        behavior: { filterable: true, searchable: true, sortable: true },
      });
      await sendCommand(catalogServices.fields.commandHandler, `catalog.field-${aliasSeed.fieldId}`, {
        type: "ActivateField",
      });
      await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${aliasSeed.blueprintId}`, {
        type: "CreateBlueprint",
        blueprintId: aliasSeed.blueprintId as never,
        key: "card",
        name: l10n("Pokemon Card"),
        description: l10n("A tradable card"),
      });
      await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${aliasSeed.blueprintId}`, {
        type: "SetBlueprintFields",
        fieldRules: [{ fieldId: aliasSeed.fieldId as never, required: true }],
      });
      await sendCommand(catalogServices.blueprints.commandHandler, `catalog.blueprint-${aliasSeed.blueprintId}`, {
        type: "PublishBlueprint",
      });

      for (const item of [
        { id: aliasSeed.englishItemId, lang: "en", title: l10n("Cacnea"), name: "Cacnea" },
        { id: aliasSeed.japaneseItemId, lang: "ja", title: l10n("サボネア"), name: "サボネア" },
      ]) {
        await sendCommand(catalogServices.items.commandHandler, `catalog.item-${item.id}`, {
          type: "CreateCatalogItem",
          itemId: item.id as never,
          languageCode: item.lang,
          title: item.title,
          subtitle: l10n("Base"),
          description: l10n("A cactus Pokemon card"),
        });
        await sendCommand(catalogServices.items.commandHandler, `catalog.item-${item.id}`, {
          type: "AssignBlueprintToCatalogItem",
          blueprintId: aliasSeed.blueprintId as never,
        });
        await sendCommand(catalogServices.items.commandHandler, `catalog.item-${item.id}`, {
          type: "SetCatalogItemFieldValue",
          fieldId: aliasSeed.fieldId as never,
          value: item.name,
        });
        await sendCommand(catalogServices.items.commandHandler, `catalog.item-${item.id}`, {
          type: "AssignCatalogItemToCategory",
          categoryId: aliasSeed.categoryId as never,
        });
        await sendCommand(catalogServices.items.commandHandler, `catalog.item-${item.id}`, {
          type: "PublishCatalogItem",
          blueprintIsActive: true,
          requiredFieldIds: [aliasSeed.fieldId as never],
        });
      }
    }

    async function recordJapaneseItemAliases(
      aliases: ReadonlyArray<Record<string, unknown>>,
      resolvedAliasHash: string,
    ) {
      await sendCommand(catalogServices.items.commandHandler, `catalog.item-${aliasSeed.japaneseItemId}`, {
        type: "RecordCatalogItemAliases",
        catalogItemId: aliasSeed.japaneseItemId as never,
        aliasLanguageCode: "en",
        aliases: aliases as never,
        resolvedAliasHash,
        resolverVersion: 1,
        resolvedAt: "2026-06-16T00:00:00.000Z",
      });
    }

    async function searchItemIds(query: string): Promise<string[]> {
      const response = await app.request(
        `/api/marketplace/items?search=${encodeURIComponent(query)}&includeTotal=true`,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      return body.items.map((item: { catalog_item_id: string }) => item.catalog_item_id);
    }

    it("finds a Japanese card by its accepted English official-equivalent alias", async () => {
      await seedAliasFixture();
      await drainContextProcesses({ subscriptionRunners });

      // Before the alias fact, an English query never reaches the Japanese card.
      expect(await searchItemIds("Cacnea")).toEqual([aliasSeed.englishItemId]);

      await recordJapaneseItemAliases(
        [
          {
            aliasHash: "alias-cacnea-en",
            aliasText: "Cacnea",
            normalizedAliasText: "cacnea",
            aliasType: "official-equivalent",
            confidence: "high",
            broad: false,
            providerKey: "tcgdex",
            sourceCategory: "provider-same-id-localized-endpoint",
          },
        ],
        "resolved-cacnea-1",
      );
      await drainContextProcesses({ subscriptionRunners });

      const ids = await searchItemIds("Cacnea");
      expect(ids).toContain(aliasSeed.englishItemId);
      expect(ids).toContain(aliasSeed.japaneseItemId);
    });

    it("keeps native Japanese kana queries searchable, including substrings", async () => {
      await seedAliasFixture();
      await drainContextProcesses({ subscriptionRunners });

      // Whole-run native query.
      expect(await searchItemIds("サボネア")).toEqual([aliasSeed.japaneseItemId]);
      // Substring native query works under the CJK n-gram tokenization.
      expect(await searchItemIds("サボネ")).toEqual([aliasSeed.japaneseItemId]);
    });

    it("ranks an exact English title above a broad species alias match", async () => {
      await seedAliasFixture();
      // The English Cacnea also carries a broad species alias for "Cacnea" so a
      // species match competes with the exact-title English item.
      await sendCommand(catalogServices.items.commandHandler, `catalog.item-${aliasSeed.englishItemId}`, {
        type: "RecordCatalogItemAliases",
        catalogItemId: aliasSeed.englishItemId as never,
        aliasLanguageCode: "en",
        aliases: [] as never,
        resolvedAliasHash: "resolved-en-empty",
        resolverVersion: 1,
        resolvedAt: "2026-06-16T00:00:00.000Z",
      });
      // Japanese card only matches "Cacnea" through a broad species alias.
      await recordJapaneseItemAliases(
        [
          {
            aliasHash: "alias-cacnea-species",
            aliasText: "Cacnea",
            normalizedAliasText: "cacnea",
            aliasType: "species-name",
            confidence: "high",
            broad: true,
            providerKey: "tcgdex",
            sourceCategory: "provider-species-name",
          },
        ],
        "resolved-cacnea-species",
      );
      await drainContextProcesses({ subscriptionRunners });

      const ids = await searchItemIds("Cacnea");
      // Exact English title outranks the broad species alias on the Japanese card.
      expect(ids[0]).toBe(aliasSeed.englishItemId);
      expect(ids).toContain(aliasSeed.japaneseItemId);
    });

    it("does not let a generated low-confidence alias outrank an official English title", async () => {
      await seedAliasFixture();
      // A second English item whose only "Cacnea" tie is a generated translation.
      await sendCommand(catalogServices.items.commandHandler, `catalog.item-cat_generated`, {
        type: "CreateCatalogItem",
        itemId: "cat_generated" as never,
        languageCode: "en",
        title: l10n("Spiky Cactus"),
        subtitle: l10n("Base"),
        description: l10n("Generated translation candidate"),
      });
      await sendCommand(catalogServices.items.commandHandler, `catalog.item-cat_generated`, {
        type: "AssignBlueprintToCatalogItem",
        blueprintId: aliasSeed.blueprintId as never,
      });
      await sendCommand(catalogServices.items.commandHandler, `catalog.item-cat_generated`, {
        type: "SetCatalogItemFieldValue",
        fieldId: aliasSeed.fieldId as never,
        value: "Spiky Cactus",
      });
      await sendCommand(catalogServices.items.commandHandler, `catalog.item-cat_generated`, {
        type: "PublishCatalogItem",
        blueprintIsActive: true,
        requiredFieldIds: [aliasSeed.fieldId as never],
      });
      await sendCommand(catalogServices.items.commandHandler, `catalog.item-cat_generated`, {
        type: "RecordCatalogItemAliases",
        catalogItemId: "cat_generated" as never,
        aliasLanguageCode: "en",
        aliases: [
          {
            aliasHash: "alias-generated",
            aliasText: "Cacnea",
            normalizedAliasText: "cacnea",
            aliasType: "generated-translation",
            confidence: "generated",
            broad: false,
            providerKey: "tcgdex",
            sourceCategory: "machine-translation",
          },
        ] as never,
        resolvedAliasHash: "resolved-generated",
        resolverVersion: 1,
        resolvedAt: "2026-06-16T00:00:00.000Z",
      });
      await drainContextProcesses({ subscriptionRunners });

      const ids = await searchItemIds("Cacnea");
      // The official English title item outranks the generated-alias item.
      expect(ids[0]).toBe(aliasSeed.englishItemId);
      expect(ids.indexOf(aliasSeed.englishItemId)).toBeLessThan(ids.indexOf("cat_generated"));
    });

    it("removes a revoked alias from search on the retraction fact and on rebuild", async () => {
      await seedAliasFixture();
      await recordJapaneseItemAliases(
        [
          {
            aliasHash: "alias-cacnea-en",
            aliasText: "Cacnea",
            normalizedAliasText: "cacnea",
            aliasType: "official-equivalent",
            confidence: "high",
            broad: false,
            providerKey: "tcgdex",
            sourceCategory: "provider-same-id-localized-endpoint",
          },
        ],
        "resolved-cacnea-1",
      );
      await drainContextProcesses({ subscriptionRunners });
      expect(await searchItemIds("Cacnea")).toContain(aliasSeed.japaneseItemId);

      // Retraction: empty resolved fact for the same (item, language).
      await recordJapaneseItemAliases([], "resolved-cacnea-empty");
      await drainContextProcesses({ subscriptionRunners });

      const afterRevoke = await searchItemIds("Cacnea");
      expect(afterRevoke).not.toContain(aliasSeed.japaneseItemId);
      // The Japanese card itself is unaffected for native queries.
      expect(await searchItemIds("サボネア")).toEqual([aliasSeed.japaneseItemId]);

      // Negative projection on rebuild: rebuilding the index keeps the alias gone.
      await rebuildDiscoverySearchIndex(pools.discovery);
      expect(await searchItemIds("Cacnea")).not.toContain(aliasSeed.japaneseItemId);

      const aliasRow = await pools.discovery.query<{ resolved_aliases: unknown }>(
        `SELECT resolved_aliases FROM discovery_search_catalog_items WHERE catalog_item_id = $1`,
        [aliasSeed.japaneseItemId],
      );
      expect(aliasRow.rows[0]?.resolved_aliases).toEqual({});
    });
  });
});

async function loadSearchIndexRow(catalogItemId: string): Promise<Record<string, unknown> | undefined> {
  const result = await pools.discovery.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(item) AS row
     FROM discovery_search_items AS item
     WHERE catalog_item_id = $1`,
    [catalogItemId],
  );
  return result.rows[0]?.row;
}

function projectionEvent(
  type: string,
  data: Record<string, unknown>,
  streamId: string,
  globalPosition: number,
): TransportEvent {
  const recordedAt = `2026-07-23T03:00:${String(globalPosition).padStart(2, "0")}.000Z`;
  return buildTransportEvent(type, data, {
    id: `evt_search_index_${globalPosition}_${type.replaceAll(".", "_")}`,
    streamId,
    streamVersion: globalPosition,
    globalPosition: String(globalPosition),
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
    timing: { occurredAt: recordedAt, recordedAt },
  });
}

function productContentsResolvedEvent(input: {
  containerCatalogItemId: string;
  containedCatalogItemId: string;
}): TransportEvent {
  return buildTransportEvent(
    "catalog.product-contents.resolved",
    {
      containerCatalogItemId: input.containerCatalogItemId,
      containerProductId: null,
      lines: [
        {
          lineId: "line_1",
          containerCatalogItemId: input.containerCatalogItemId,
          containerProductId: null,
          containedCatalogItemId: input.containedCatalogItemId,
          containedProductId: null,
          contentTypeId: "pct_included_item",
          contentTypeDiscoverySearchWeight: 0.5,
          resolutionStatus: "resolved",
        },
      ],
      resolvedFactHash: "hash",
      resolverVersion: 1,
      resolvedAt: "2026-07-02T00:00:00.000Z",
    },
    {
      id: "evt_contents",
      streamId: `catalog.product-contents-${input.containerCatalogItemId}`,
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
      timing: { occurredAt: "2026-07-02T00:00:00.000Z", recordedAt: "2026-07-02T00:00:00.000Z" },
    },
  );
}

function displayIdentityResolvedEvent(input: {
  catalogItemId: string;
  title: string;
  subtitle: string | null;
}): TransportEvent {
  return buildTransportEvent(
    "catalog.catalog-item.display-identity-resolved",
    {
      catalogItemId: input.catalogItemId,
      languageCode: "en",
      title: input.title,
      subtitle: input.subtitle,
    },
    {
      id: `evt_identity_${input.catalogItemId}`,
      streamId: `catalog.item-${input.catalogItemId}`,
      streamVersion: 2,
      globalPosition: "2",
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
      timing: { occurredAt: "2026-07-02T00:00:00.000Z", recordedAt: "2026-07-02T00:00:00.000Z" },
    },
  );
}

function catalogItemPublishedEvent(catalogItemId: string): TransportEvent {
  return buildTransportEvent(
    "catalog.catalog-item.published",
    { blueprintId: null },
    {
      id: `evt_publish_${catalogItemId}`,
      streamId: `catalog.item-${catalogItemId}`,
      streamVersion: 2,
      globalPosition: "2",
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
      timing: { occurredAt: "2026-07-02T00:00:00.000Z", recordedAt: "2026-07-02T00:00:00.000Z" },
    },
  );
}
