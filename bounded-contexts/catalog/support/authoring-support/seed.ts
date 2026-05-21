import type { BcSeedOptions } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createCatalogServices } from "./services";
import { seedBlueprints } from "../../features/blueprints/api/seed";
import type { BlueprintIds } from "../../features/blueprints/api/seed";
import { seedCatalogItems } from "../../features/catalog-items/api/seed";
import { seedCategories } from "../../features/categories/api/seed";
import type { CategoryIds } from "../../features/categories/api/seed";
import { seedComponents } from "../../features/components/api/seed";
import type { ComponentIds } from "../../features/components/api/seed";
import { seedDimensions } from "../../features/dimensions/api/seed";
import type { DimensionIds } from "../../features/dimensions/api/seed";
import { seedFields } from "../../features/fields/api/seed";
import type { FieldIds } from "../../features/fields/api/seed";
import { seedProductMeasures } from "../../features/product-measures/api/seed";
import { seedReferenceData } from "../../features/reference-data/api/seed";
import type { PokemonReferenceIds } from "../../features/reference-data/api/seed";
import { catalogSeedIds } from "../seed-support/ids";
import { drainProjectors } from "../seed-support/context";
import type { BlueprintId, CategoryId, ComponentId, DimensionId, FieldId, OptionId } from "../../ids";

export async function seedCatalogDatabase(pool: PgTransactionalPool, _services?: unknown, options?: BcSeedOptions) {
  const services = createCatalogServices(pool);
  const shouldSeedIntegrationProfile = profileEnabled(options, "catalog-integration-bootstrap");
  const shouldSeedScenarioData = profileEnabled(options, "scenario-seed");

  if (!shouldSeedIntegrationProfile && !shouldSeedScenarioData) {
    console.log("Catalog seed skipped for selected data profiles.");
    return;
  }

  console.log("Starting Pokemon TCG catalog integration profile seed...\n");

  const authoring = shouldSeedIntegrationProfile
    ? await seedTcgdexCatalogIntegrationProfile(pool)
    : staticTcgdexCatalogIntegrationIds();

  if (shouldSeedScenarioData) {
    await seedCatalogScenarioData(pool, authoring);
  }

  if (shouldSeedIntegrationProfile || shouldSeedScenarioData) {
    await seedProductMeasures(createCatalogServices(pool), {
      resolveExistingCatalogItems: shouldSeedScenarioData,
    });
  }

  console.log("\nCatalog seed reconciliation complete!");
}

export async function seedTcgdexCatalogIntegrationProfile(
  pool: PgTransactionalPool,
): Promise<TcgdexCatalogIntegrationIds> {
  const services = createCatalogServices(pool);

  if (await tableHasRows(services.db, "catalog_dimensions")) {
    console.log("Pokemon TCG catalog integration profile already exists. Reconciling fields.");
    const fields = await seedFields(services);
    await drainProjectors("catalog", services.projectors);
    return {
      ...staticTcgdexCatalogIntegrationIds(),
      fields,
    };
  }

  console.log("Seeding Pokemon TCG catalog integration structure...");

  const [dimensions, fields] = await Promise.all([seedDimensions(services), seedFields(services)]);

  const references = await seedReferenceData(services);
  const components = await seedComponents(services, dimensions, fields);
  const blueprints = await seedBlueprints(services, components, dimensions, fields);
  const categories = await seedCategories(services);
  await drainProjectors("catalog", services.projectors);

  return {
    dimensions,
    fields,
    references,
    components,
    blueprints,
    categories,
  };
}

async function seedCatalogScenarioData(
  pool: PgTransactionalPool,
  authoring: TcgdexCatalogIntegrationIds,
): Promise<void> {
  const services = createCatalogServices(pool);

  if (await tableHasRows(services.db, "catalog_items")) {
    console.log("Catalog scenario items already exist. Skipping scenario seed.");
    return;
  }

  console.log("Seeding non-production Catalog scenario items...");
  await seedCatalogItems(services, authoring.blueprints, authoring.fields, authoring.categories, authoring.references);
  await drainProjectors("catalog", services.projectors);
}

type TcgdexCatalogIntegrationIds = Readonly<{
  dimensions: DimensionIds;
  fields: FieldIds;
  references: PokemonReferenceIds;
  components: ComponentIds;
  blueprints: BlueprintIds;
  categories: CategoryIds;
}>;

function profileEnabled(
  options: BcSeedOptions | undefined,
  profile: "catalog-integration-bootstrap" | "scenario-seed",
) {
  return (
    options?.enabledDataProfiles ?? ["critical-bootstrap", "catalog-integration-bootstrap", "scenario-seed"]
  ).includes(profile);
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

function staticTcgdexCatalogIntegrationIds(): TcgdexCatalogIntegrationIds {
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
    expansion: catalogSeedIds.fields.expansion as FieldId,
    rarity: catalogSeedIds.fields.rarity as FieldId,
    "card-variant": catalogSeedIds.fields.cardVariant as FieldId,
    "card-illustrator": catalogSeedIds.fields.cardIllustrator as FieldId,
    "release-year": catalogSeedIds.fields.releaseYear as FieldId,
    "pack-count": catalogSeedIds.fields.packCount as FieldId,
  };
  const references: PokemonReferenceIds = {
    expansions: {
      "base-set": catalogSeedIds.referenceRecords.expansions.baseSet,
      jungle: catalogSeedIds.referenceRecords.expansions.jungle,
      "neo-genesis": catalogSeedIds.referenceRecords.expansions.neoGenesis,
      "wizards-black-star-promos": catalogSeedIds.referenceRecords.expansions.wizardsBlackStarPromos,
      "prismatic-evolutions": catalogSeedIds.referenceRecords.expansions.prismaticEvolutions,
      "surging-sparks": catalogSeedIds.referenceRecords.expansions.surgingSparks,
      "twilight-masquerade": catalogSeedIds.referenceRecords.expansions.twilightMasquerade,
    },
  };
  const components: ComponentIds = {
    "single-card-identity": catalogSeedIds.components.singleCardIdentity as ComponentId,
    "single-card-product-resolution": catalogSeedIds.components.singleCardProductResolution as ComponentId,
    "sealed-product-identity": catalogSeedIds.components.sealedProductIdentity as ComponentId,
  };
  const blueprints: BlueprintIds = {
    "pokemon-card-single": catalogSeedIds.blueprints.pokemonCardSingle as BlueprintId,
    "pokemon-sealed-product": catalogSeedIds.blueprints.pokemonSealedProduct as BlueprintId,
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
