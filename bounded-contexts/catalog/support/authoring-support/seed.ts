import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BcSeedOptions, EnvironmentDataProfile } from "@chase-sets/bounded-context-module";
import {
  createProjectionAwarePool,
  drainLocalProjectionHandlerSets,
  rebuildLocalProjectionHandlerSets,
} from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createCatalogServices, type CatalogServices } from "./services";
import {
  seedBlueprints,
  seedLorcanaBlueprints,
  seedMagicBlueprints,
  seedOnePieceBlueprints,
} from "../../features/blueprints/api/seed";
import type { BlueprintIds } from "../../features/blueprints/api/seed";
import { seedCatalogItems } from "../../features/catalog-items/api/seed";
import {
  seedCategories,
  seedLorcanaCategories,
  seedMagicCategories,
  seedOnePieceCategories,
} from "../../features/categories/api/seed";
import type { CategoryIds } from "../../features/categories/api/seed";
import {
  seedComponents,
  seedLorcanaComponents,
  seedMagicComponents,
  seedOnePieceComponents,
} from "../../features/components/api/seed";
import type { ComponentIds } from "../../features/components/api/seed";
import { seedDimensions } from "../../features/dimensions/api/seed";
import type { DimensionIds } from "../../features/dimensions/api/seed";
import { seedDisplayTemplates } from "../../features/display-templates/api/seed";
import { seedFields } from "../../features/fields/api/seed";
import type { FieldIds } from "../../features/fields/api/seed";
import { seedProductMeasures } from "../../features/product-measures/api/seed";
import { seedProductContentConfiguration, seedProductContentScenario } from "../../features/product-contents/api/seed";
import { seedReferenceData } from "../../features/reference-data/api/seed";
import type { CatalogReferenceIds } from "../../features/reference-data/api/seed";
import { seedPromotedSourceObservationScenario } from "../../features/source-observations/api/seed";
import {
  buildRepresentativeCatalogReplayReceipt,
  replayRepresentativeCatalogPacks,
} from "../../features/source-observations/api/representative-catalog-replay";
import { seedCatalogProviderIntegrationProfileVersions } from "../../features/source-observations/api/provider-integration-profile-store";
import { catalogSeedIds, representativeProductContentsScenario } from "@chase-sets/catalog-seed";
import type { BlueprintId, CatalogItemId, CategoryId, ComponentId, DimensionId, FieldId, OptionId } from "../../ids";
import { seedContext } from "../seed-support/context";

export async function seedCatalogDatabase(
  pool: PgTransactionalPool,
  providedServices?: CatalogServices,
  options?: BcSeedOptions,
) {
  const services = providedServices ?? createCatalogServices(createProjectionAwarePool(pool));
  const shouldSeedIntegrationProfile = profileEnabled(options, "catalog-integration-bootstrap");
  const shouldSeedScenarioData = profileEnabled(options, "scenario-seed");
  const shouldSeedRepresentativeProductContents = profileEnabled(options, "representative-commerce-state");
  const shouldSeedRepresentativeCatalog = profileEnabled(options, "representative-catalog");
  const shouldSeedAuthoring = shouldSeedIntegrationProfile || shouldSeedRepresentativeCatalog;

  if (
    !shouldSeedIntegrationProfile &&
    !shouldSeedScenarioData &&
    !shouldSeedRepresentativeProductContents &&
    !shouldSeedRepresentativeCatalog
  ) {
    console.log("Catalog seed skipped for selected data profiles.");
    return;
  }

  console.log("Starting Catalog integration profile seed...\n");

  if (shouldSeedAuthoring) {
    await recoverCatalogIntegrationSeedProjections(services);
  }
  const authoring = shouldSeedAuthoring
    ? await seedCatalogIntegrationProfile(pool, services)
    : staticCatalogIntegrationIds();

  if (shouldSeedRepresentativeCatalog) {
    await drainLocalProjectionHandlerSets("catalog", pool, services.projectors);
    const summaries = await replayRepresentativeCatalogPacks({
      services,
      source: process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE,
      context: seedContext,
    });
    for (const summary of summaries) {
      console.log(
        JSON.stringify({
          event: "representative-catalog-pack-replayed",
          packId: summary.packId,
          packVersion: summary.packVersion,
          manifestKey: summary.manifestKey,
          captureContentHash: summary.captureContentHash,
          providerKey: summary.providerKey,
          envelopeCount: summary.envelopeCount,
          observationCount: summary.observationCount,
          catalogItemCount: summary.catalogItemCount,
          assetSetCount: summary.assetSetCount,
          appendedEventCount: summary.appendedEventCount,
          appendedAssetSetCount: summary.appendedAssetSetCount,
          externalReferenceDigest: summary.externalReferenceDigest,
        }),
      );
    }
    const replayEvidenceOut = process.env.REPRESENTATIVE_CATALOG_REPLAY_EVIDENCE_OUT?.trim();
    if (replayEvidenceOut) {
      await writeRepresentativeCatalogReplayReceipt(
        replayEvidenceOut,
        buildRepresentativeCatalogReplayReceipt(
          summaries,
          new Date().toISOString(),
          representativeCatalogReplaySandboxBinding(process.env),
        ),
      );
    }
  }

  if (shouldSeedScenarioData) {
    await seedCatalogScenarioData(pool, authoring);
  }

  if (shouldSeedRepresentativeProductContents) {
    await seedRepresentativeProductContentsCatalogItems(pool, authoring);
  }

  if (shouldSeedAuthoring || shouldSeedScenarioData) {
    await seedProductMeasures(createCatalogServices(pool), {
      resolveExistingCatalogItems: shouldSeedScenarioData,
    });
  }

  console.log("\nCatalog seed reconciliation complete!");
}

async function writeRepresentativeCatalogReplayReceipt(
  outPath: string | null | undefined,
  receipt: ReturnType<typeof buildRepresentativeCatalogReplayReceipt>,
): Promise<void> {
  const normalizedOutPath = outPath?.trim();
  if (!normalizedOutPath) {
    return;
  }
  await mkdir(dirname(normalizedOutPath), { recursive: true });
  await writeFile(normalizedOutPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function representativeCatalogReplaySandboxBinding(env: NodeJS.ProcessEnv): Readonly<{
  sandboxId: string;
  postgresPort: number;
  catalogDatabaseName: string;
}> {
  const sandboxId = env.CHASE_SETS_SANDBOX_ID?.trim();
  const databaseUrl = env.DATABASE_URL_CATALOG?.trim();
  if (!sandboxId || !databaseUrl) {
    throw new Error("Representative Catalog replay evidence requires the current sandbox identity.");
  }
  const parsed = new URL(databaseUrl);
  const postgresPort = Number(parsed.port || "5432");
  const catalogDatabaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  if (
    parsed.protocol !== "postgresql:" ||
    !Number.isSafeInteger(postgresPort) ||
    postgresPort <= 0 ||
    !catalogDatabaseName
  ) {
    throw new Error("Representative Catalog replay evidence requires a canonical Catalog database target.");
  }
  return { sandboxId, postgresPort, catalogDatabaseName };
}

async function seedCatalogIntegrationProfile(
  pool: PgTransactionalPool,
  services: CatalogServices,
): Promise<CatalogIntegrationIds> {
  await seedCatalogProviderIntegrationProfileVersions(pool);
  return seedTcgdexCatalogIntegrationProfile(pool, services);
}

export async function seedTcgdexCatalogIntegrationProfile(
  pool: PgTransactionalPool,
  providedServices?: CatalogServices,
): Promise<CatalogIntegrationIds> {
  const services = providedServices ?? createCatalogServices(createProjectionAwarePool(pool));

  if (await catalogIntegrationDimensionStreamsComplete(services)) {
    console.log("Catalog integration structure already exists. Reconciling additive seed definitions.");
    const dimensions = await seedDimensions(services);
    const fields = await seedFields(services);
    await syncDisplayTemplateAuthoringDependencies(pool, services);
    await seedReferenceData(services);
    const components = await seedMagicComponents(services, dimensions, fields);
    Object.assign(components, await seedOnePieceComponents(services, dimensions, fields));
    Object.assign(components, await seedLorcanaComponents(services, dimensions, fields));
    await seedMagicBlueprints(services, components, dimensions, fields);
    await seedOnePieceBlueprints(services, components, dimensions, fields);
    await seedLorcanaBlueprints(services, components, dimensions, fields);
    await seedMagicCategories(services);
    await seedOnePieceCategories(services);
    await seedLorcanaCategories(services);
    await syncDisplayTemplateAuthoringDependencies(pool, services);
    await seedDisplayTemplatesWhenAuthoringDependenciesAreActive(pool, services, fields);
    await seedProductContentConfiguration(services);
    return {
      ...staticCatalogIntegrationIds(),
      fields,
    };
  }

  console.log("Seeding Pokemon TCG catalog integration structure...");

  const [dimensions, fields] = await Promise.all([seedDimensions(services), seedFields(services)]);

  const references = await seedReferenceData(services);
  const components = await seedComponents(services, dimensions, fields);
  const blueprints = await seedBlueprints(services, components, dimensions, fields);
  const categories = await seedCategories(services);
  await syncDisplayTemplateAuthoringDependencies(pool, services);
  await seedDisplayTemplatesWhenAuthoringDependenciesAreActive(pool, services, fields);
  await seedProductContentConfiguration(services);

  return {
    dimensions,
    fields,
    references,
    components,
    blueprints,
    categories,
  };
}

async function syncDisplayTemplateAuthoringDependencies(
  pool: PgTransactionalPool,
  services: CatalogServices,
): Promise<void> {
  // Reference Types and Reference Records share one checkpointed projector, so the
  // combined reference-data set is the narrow safe unit for making type status visible.
  await drainLocalProjectionHandlerSets("catalog", pool, [
    ...services.fields.projectors,
    ...services.referenceData.projectors,
  ]);
}

/**
 * Template publication validates against active Field and Reference Type read models.
 * Seed commands append those authoring facts first; the Catalog seed drains only their
 * Catalog-owned projections before this reconciliation pass publishes templates.
 */
async function seedDisplayTemplatesWhenAuthoringDependenciesAreActive(
  pool: PgTransactionalPool,
  services: CatalogServices,
  fields: FieldIds,
): Promise<void> {
  const requiredFieldKeys = Object.keys(fields);
  const [activeFields, activeReferenceTypes] = await Promise.all([
    services.db.query<{ key: string }>(
      `SELECT key FROM catalog_fields WHERE status = 'active' AND key = ANY($1::text[])`,
      [requiredFieldKeys],
    ),
    services.db.query<{ key: string }>(
      `SELECT key FROM catalog_reference_types WHERE status = 'active' AND key = ANY($1::text[])`,
      [["expansion", "set"]],
    ),
  ]);

  if (activeFields.rows.length !== requiredFieldKeys.length || activeReferenceTypes.rows.length !== 2) {
    console.log("Catalog display template seed deferred until Field and Reference Type projections are active.");
    return;
  }

  await seedDisplayTemplates(services);
  await drainLocalProjectionHandlerSets("catalog", pool, services.displayTemplates.projectors);
}

async function seedCatalogScenarioData(pool: PgTransactionalPool, authoring: CatalogIntegrationIds): Promise<void> {
  const services = createCatalogServices(pool);

  if (await tableHasRows(services.db, "catalog_items")) {
    console.log("Catalog scenario items already exist. Reconciling exact integration prerequisites.");
    const targetStreamId = `catalog.item-${catalogSeedIds.items.pikachuJungle}`;
    const targetEvents = await services.db.query<{ event_type: string }>(
      `SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC`,
      [targetStreamId],
    );
    if (targetEvents.rows.length === 0) {
      await seedCatalogItems(
        services,
        authoring.blueprints,
        authoring.fields,
        authoring.categories,
        authoring.references,
        { catalogItemIds: [catalogSeedIds.items.pikachuJungle as CatalogItemId] },
      );
    }
  } else {
    console.log("Seeding non-production Catalog scenario items...");
    await seedCatalogItems(
      services,
      authoring.blueprints,
      authoring.fields,
      authoring.categories,
      authoring.references,
    );
  }

  // Promotion requires the exact target in both its event stream and read model.
  // Drain Catalog Item projections after either a full or targeted reconciliation;
  // a partial/terminal target stream then fails deterministically in the observation seed.
  await drainLocalProjectionHandlerSets("catalog", pool, services.items.projectors);
  await seedProductContentScenario(services);
  await seedPromotedSourceObservationScenario(services);
}

async function seedRepresentativeProductContentsCatalogItems(
  pool: PgTransactionalPool,
  authoring: CatalogIntegrationIds,
): Promise<void> {
  const services = createCatalogServices(pool);
  const streamIds = representativeProductContentsScenario.requiredCatalogItemIds.map(
    (catalogItemId) => `catalog.item-${catalogItemId}`,
  );
  const existing = await services.db.query<{ stream_id: string }>(
    `SELECT DISTINCT stream_id FROM event_store_events WHERE stream_id = ANY($1::text[])`,
    [streamIds],
  );
  const existingStreamIds = new Set(existing.rows.map((row) => row.stream_id));
  const missingCatalogItemIds = representativeProductContentsScenario.requiredCatalogItemIds.filter(
    (catalogItemId) => !existingStreamIds.has(`catalog.item-${catalogItemId}`),
  );

  if (missingCatalogItemIds.length === 0) {
    console.log("Representative Product Contents Catalog Items already exist.");
    return;
  }

  console.log("Seeding representative Product Contents Catalog Items...");
  await seedCatalogItems(services, authoring.blueprints, authoring.fields, authoring.categories, authoring.references, {
    catalogItemIds: missingCatalogItemIds,
  });
}

type CatalogIntegrationIds = Readonly<{
  dimensions: DimensionIds;
  fields: FieldIds;
  references: CatalogReferenceIds;
  components: ComponentIds;
  blueprints: BlueprintIds;
  categories: CategoryIds;
}>;

function profileEnabled(
  options: BcSeedOptions | undefined,
  profile:
    | "catalog-integration-bootstrap"
    | "scenario-seed"
    | "representative-commerce-state"
    | "representative-catalog",
) {
  const defaultProfiles: readonly EnvironmentDataProfile[] = [
    "critical-bootstrap",
    "catalog-integration-bootstrap",
    "scenario-seed",
  ];

  return (options?.enabledDataProfiles ?? defaultProfiles).includes(profile);
}

const catalogIntegrationSeedProjectionNames = new Set([
  "catalog-blueprint-projection",
  "catalog-category-projection",
  "catalog-component-projection",
  "catalog-dimension-projection",
  "catalog-display-template-projection",
  "catalog-field-projection",
  "catalog-reference-data-projection",
]);

async function recoverCatalogIntegrationSeedProjections(services: CatalogServices): Promise<void> {
  const dimensionIds = Object.values(catalogSeedIds.dimensions).map(({ dimensionId }) => dimensionId);
  const [streams, projections] = await Promise.all([
    services.db.query<{ dimension_id: string }>(
      `SELECT substring(stream_id FROM length('catalog.dimension-') + 1) AS dimension_id
       FROM event_store_streams
       WHERE stream_id = ANY($1::text[])`,
      [dimensionIds.map((dimensionId) => `catalog.dimension-${dimensionId}`)],
    ),
    services.db.query<{ dimension_id: string }>(
      `SELECT dimension_id
       FROM catalog_dimensions
       WHERE dimension_id = ANY($1::text[])`,
      [dimensionIds],
    ),
  ]);
  const projectedIds = new Set(projections.rows.map(({ dimension_id }) => dimension_id));
  if (streams.rows.length === 0 || streams.rows.every(({ dimension_id }) => projectedIds.has(dimension_id))) {
    return;
  }

  const seedProjectors = services.projectors.filter(({ projectionName }) =>
    catalogIntegrationSeedProjectionNames.has(projectionName),
  );
  if (seedProjectors.length !== catalogIntegrationSeedProjectionNames.size) {
    throw new Error("Catalog integration bootstrap is missing a seed prerequisite projector.");
  }

  console.log("Catalog integration projections are behind retained seed streams. Rebuilding seed prerequisites.");
  await rebuildLocalProjectionHandlerSets("catalog", services.pool, seedProjectors);
}

async function catalogIntegrationDimensionStreamsComplete(services: CatalogServices): Promise<boolean> {
  const streamIds = Object.values(catalogSeedIds.dimensions).map(
    ({ dimensionId }) => `catalog.dimension-${dimensionId}`,
  );
  const existing = await services.db.query<{ stream_count: string }>(
    `SELECT COUNT(*) AS stream_count
     FROM event_store_streams
     WHERE stream_id = ANY($1::text[])`,
    [streamIds],
  );
  return Number(existing.rows[0]?.stream_count ?? 0) === streamIds.length;
}

async function tableHasRows(
  db: { query: (sql: string) => Promise<{ rows: readonly { count?: string | number }[] }> },
  tableName: string,
): Promise<boolean> {
  try {
    const existing = await db.query(`SELECT COUNT(*) AS count FROM ${tableName}`);
    return Number(existing.rows[0]?.count ?? 0) > 0;
  } catch {
    return false;
  }
}

function staticCatalogIntegrationIds(): CatalogIntegrationIds {
  const dimensions: DimensionIds = {
    form: {
      dimensionId: catalogSeedIds.dimensions.form.dimensionId as DimensionId,
      optionIds: {
        raw: catalogSeedIds.dimensions.form.optionIds.raw as OptionId,
        graded: catalogSeedIds.dimensions.form.optionIds.graded as OptionId,
      },
      orderedOptionIds: [
        catalogSeedIds.dimensions.form.optionIds.raw as OptionId,
        catalogSeedIds.dimensions.form.optionIds.graded as OptionId,
      ],
    },
    condition: {
      dimensionId: catalogSeedIds.dimensions.condition.dimensionId as DimensionId,
      optionIds: catalogSeedIds.dimensions.condition.optionIds as Record<string, OptionId>,
      orderedOptionIds: [
        catalogSeedIds.dimensions.condition.optionIds.pristine,
        catalogSeedIds.dimensions.condition.optionIds.mint,
        catalogSeedIds.dimensions.condition.optionIds.nearMint,
        catalogSeedIds.dimensions.condition.optionIds.excellent,
        catalogSeedIds.dimensions.condition.optionIds.good,
        catalogSeedIds.dimensions.condition.optionIds.poor,
        catalogSeedIds.dimensions.condition.optionIds.damaged,
      ] as OptionId[],
    },
    "grading-company": {
      dimensionId: catalogSeedIds.dimensions.gradingCompany.dimensionId as DimensionId,
      optionIds: catalogSeedIds.dimensions.gradingCompany.optionIds as Record<string, OptionId>,
      orderedOptionIds: [
        catalogSeedIds.dimensions.gradingCompany.optionIds.psa,
        catalogSeedIds.dimensions.gradingCompany.optionIds.bgs,
        catalogSeedIds.dimensions.gradingCompany.optionIds.cgc,
        catalogSeedIds.dimensions.gradingCompany.optionIds.sgc,
        catalogSeedIds.dimensions.gradingCompany.optionIds.ace,
        catalogSeedIds.dimensions.gradingCompany.optionIds.tag,
      ] as OptionId[],
    },
    grade: {
      dimensionId: catalogSeedIds.dimensions.grade.dimensionId as DimensionId,
      optionIds: catalogSeedIds.dimensions.grade.optionIds as Record<string, OptionId>,
      orderedOptionIds: [
        catalogSeedIds.dimensions.grade.optionIds.pristine10,
        catalogSeedIds.dimensions.grade.optionIds.gemMint10,
        catalogSeedIds.dimensions.grade.optionIds.mint95,
        catalogSeedIds.dimensions.grade.optionIds.mint9,
        catalogSeedIds.dimensions.grade.optionIds.nmMt85,
        catalogSeedIds.dimensions.grade.optionIds.nmMt8,
        catalogSeedIds.dimensions.grade.optionIds.nm7,
        catalogSeedIds.dimensions.grade.optionIds.ex6,
        catalogSeedIds.dimensions.grade.optionIds.ex5,
        catalogSeedIds.dimensions.grade.optionIds.vg4,
        catalogSeedIds.dimensions.grade.optionIds.good3,
        catalogSeedIds.dimensions.grade.optionIds.good2,
        catalogSeedIds.dimensions.grade.optionIds.poor1,
      ] as OptionId[],
    },
  };
  const fields: FieldIds = {
    "card-number": catalogSeedIds.fields.cardNumber as FieldId,
    "card-name": catalogSeedIds.fields.cardName as FieldId,
    set: catalogSeedIds.fields.set as FieldId,
    expansion: catalogSeedIds.fields.expansion as FieldId,
    rarity: catalogSeedIds.fields.rarity as FieldId,
    "card-variant": catalogSeedIds.fields.cardVariant as FieldId,
    "card-illustrator": catalogSeedIds.fields.cardIllustrator as FieldId,
    "ink-color": catalogSeedIds.fields.inkColor as FieldId,
    "card-type": catalogSeedIds.fields.cardType as FieldId,
    "card-classifications": catalogSeedIds.fields.cardClassifications as FieldId,
    "card-properties": catalogSeedIds.fields.cardProperties as FieldId,
    "release-year": catalogSeedIds.fields.releaseYear as FieldId,
    "pack-count": catalogSeedIds.fields.packCount as FieldId,
    "sealed-product-form": catalogSeedIds.fields.sealedProductForm as FieldId,
  };
  const references: CatalogReferenceIds = {
    expansions: {
      "base-set": catalogSeedIds.referenceRecords.expansions.baseSet,
      jungle: catalogSeedIds.referenceRecords.expansions.jungle,
      "neo-genesis": catalogSeedIds.referenceRecords.expansions.neoGenesis,
      "wizards-black-star-promos": catalogSeedIds.referenceRecords.expansions.wizardsBlackStarPromos,
      "prismatic-evolutions": catalogSeedIds.referenceRecords.expansions.prismaticEvolutions,
      "surging-sparks": catalogSeedIds.referenceRecords.expansions.surgingSparks,
      "twilight-masquerade": catalogSeedIds.referenceRecords.expansions.twilightMasquerade,
    },
    magic: {
      sets: {
        "time-spiral": catalogSeedIds.referenceRecords.sets.timeSpiral,
      },
    },
    onePiece: {
      sets: {
        "romance-dawn": catalogSeedIds.referenceRecords.sets.romanceDawn,
      },
    },
    lorcana: {
      sets: {
        "the-first-chapter": catalogSeedIds.referenceRecords.sets.lorcanaTheFirstChapter,
        "d23-collection": catalogSeedIds.referenceRecords.sets.lorcanaD23Collection,
      },
    },
  };
  const components: ComponentIds = {
    "single-card-identity": catalogSeedIds.components.singleCardIdentity as ComponentId,
    "single-card-product-resolution": catalogSeedIds.components.singleCardProductResolution as ComponentId,
    "sealed-product-identity": catalogSeedIds.components.sealedProductIdentity as ComponentId,
    "magic-card-print-identity": catalogSeedIds.components.magicCardPrintIdentity as ComponentId,
    "magic-card-product-resolution": catalogSeedIds.components.magicCardProductResolution as ComponentId,
    "magic-sealed-product-identity": catalogSeedIds.components.magicSealedProductIdentity as ComponentId,
    "one-piece-card-print-identity": catalogSeedIds.components.onePieceCardPrintIdentity as ComponentId,
    "one-piece-card-product-resolution": catalogSeedIds.components.onePieceCardProductResolution as ComponentId,
    "one-piece-sealed-product-identity": catalogSeedIds.components.onePieceSealedProductIdentity as ComponentId,
    "lorcana-card-print-identity": catalogSeedIds.components.lorcanaCardPrintIdentity as ComponentId,
    "lorcana-card-product-resolution": catalogSeedIds.components.lorcanaCardProductResolution as ComponentId,
    "lorcana-sealed-product-identity": catalogSeedIds.components.lorcanaSealedProductIdentity as ComponentId,
  };
  const blueprints: BlueprintIds = {
    "pokemon-card-single": catalogSeedIds.blueprints.pokemonCardSingle as BlueprintId,
    "pokemon-sealed-product": catalogSeedIds.blueprints.pokemonSealedProduct as BlueprintId,
    "magic-card-print": catalogSeedIds.blueprints.magicCardPrint as BlueprintId,
    "magic-sealed-product": catalogSeedIds.blueprints.magicSealedProduct as BlueprintId,
    "one-piece-card-print": catalogSeedIds.blueprints.onePieceCardPrint as BlueprintId,
    "one-piece-sealed-product": catalogSeedIds.blueprints.onePieceSealedProduct as BlueprintId,
    "lorcana-card-print": catalogSeedIds.blueprints.lorcanaCardPrint as BlueprintId,
    "lorcana-sealed-product": catalogSeedIds.blueprints.lorcanaSealedProduct as BlueprintId,
  };
  const categories: CategoryIds = {
    "pokemon-tcg": catalogSeedIds.categories.pokemonTcg as CategoryId,
    singles: catalogSeedIds.categories.singles as CategoryId,
    "sealed-products": catalogSeedIds.categories.sealedProducts as CategoryId,
    "booster-packs": catalogSeedIds.categories.boosterPacks as CategoryId,
    "booster-boxes": catalogSeedIds.categories.boosterBoxes as CategoryId,
    "elite-trainer-boxes": catalogSeedIds.categories.eliteTrainerBoxes as CategoryId,
    "by-generation": catalogSeedIds.categories.byGeneration as CategoryId,
    "gen-1": catalogSeedIds.categories.gen1 as CategoryId,
    "gen-2": catalogSeedIds.categories.gen2 as CategoryId,
    "gen-3": catalogSeedIds.categories.gen3 as CategoryId,
    "gen-4": catalogSeedIds.categories.gen4 as CategoryId,
    "gen-5": catalogSeedIds.categories.gen5 as CategoryId,
    "gen-6": catalogSeedIds.categories.gen6 as CategoryId,
    "gen-7": catalogSeedIds.categories.gen7 as CategoryId,
    "gen-8": catalogSeedIds.categories.gen8 as CategoryId,
    "gen-9": catalogSeedIds.categories.gen9 as CategoryId,
    "by-type": catalogSeedIds.categories.byType as CategoryId,
    fire: catalogSeedIds.categories.fire as CategoryId,
    water: catalogSeedIds.categories.water as CategoryId,
    grass: catalogSeedIds.categories.grass as CategoryId,
    electric: catalogSeedIds.categories.electric as CategoryId,
    psychic: catalogSeedIds.categories.psychic as CategoryId,
    fighting: catalogSeedIds.categories.fighting as CategoryId,
    dark: catalogSeedIds.categories.dark as CategoryId,
    metal: catalogSeedIds.categories.metal as CategoryId,
    dragon: catalogSeedIds.categories.dragon as CategoryId,
    fairy: catalogSeedIds.categories.fairy as CategoryId,
    normal: catalogSeedIds.categories.normal as CategoryId,
    colorless: catalogSeedIds.categories.colorless as CategoryId,
    "trainer-cards": catalogSeedIds.categories.trainerCards as CategoryId,
    "energy-cards": catalogSeedIds.categories.energyCards as CategoryId,
    "magic-the-gathering": catalogSeedIds.categories.magicTheGathering as CategoryId,
    "magic-card-prints": catalogSeedIds.categories.magicCardPrints as CategoryId,
    "magic-sealed-products": catalogSeedIds.categories.magicSealedProducts as CategoryId,
    "magic-booster-packs": catalogSeedIds.categories.magicBoosterPacks as CategoryId,
    "magic-booster-boxes": catalogSeedIds.categories.magicBoosterBoxes as CategoryId,
    "one-piece-card-game": catalogSeedIds.categories.onePieceCardGame as CategoryId,
    "one-piece-card-prints": catalogSeedIds.categories.onePieceCardPrints as CategoryId,
    "one-piece-sealed-products": catalogSeedIds.categories.onePieceSealedProducts as CategoryId,
    "one-piece-booster-packs": catalogSeedIds.categories.onePieceBoosterPacks as CategoryId,
    "one-piece-booster-boxes": catalogSeedIds.categories.onePieceBoosterBoxes as CategoryId,
    "one-piece-starter-decks": catalogSeedIds.categories.onePieceStarterDecks as CategoryId,
    lorcana: catalogSeedIds.categories.lorcana as CategoryId,
    "lorcana-sets": catalogSeedIds.categories.lorcanaSets as CategoryId,
    "lorcana-special-sets": catalogSeedIds.categories.lorcanaSpecialSets as CategoryId,
    "lorcana-card-prints": catalogSeedIds.categories.lorcanaCardPrints as CategoryId,
    "lorcana-sealed-products": catalogSeedIds.categories.lorcanaSealedProducts as CategoryId,
    "lorcana-booster-packs": catalogSeedIds.categories.lorcanaBoosterPacks as CategoryId,
    "lorcana-sleeved-boosters": catalogSeedIds.categories.lorcanaSleevedBoosters as CategoryId,
    "lorcana-booster-boxes": catalogSeedIds.categories.lorcanaBoosterBoxes as CategoryId,
    "lorcana-booster-cases": catalogSeedIds.categories.lorcanaBoosterCases as CategoryId,
    "lorcana-starter-decks": catalogSeedIds.categories.lorcanaStarterDecks as CategoryId,
    "lorcana-troves": catalogSeedIds.categories.lorcanaTrove as CategoryId,
    "lorcana-gift-sets": catalogSeedIds.categories.lorcanaGiftSets as CategoryId,
    "lorcana-collection-starters": catalogSeedIds.categories.lorcanaCollectionStarters as CategoryId,
    "lorcana-prerelease-boxes": catalogSeedIds.categories.lorcanaPrereleaseBoxes as CategoryId,
    "lorcana-quests-and-product-bundles": catalogSeedIds.categories.lorcanaQuestsAndProductBundles as CategoryId,
  };

  return {
    dimensions,
    fields,
    references,
    components,
    blueprints,
    categories,
  };
}
