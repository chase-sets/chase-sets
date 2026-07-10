import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { seedContext } from "../../../support/seed-support/context";
import type { CatalogItemId } from "../../../ids";

const scenarioContainerCatalogItemId = catalogSeedIds.items.prismaticEvolutionsBoosterPack as CatalogItemId;
const scenarioContainedCatalogItemId = catalogSeedIds.items.pikachuPrismaticEvolutions as CatalogItemId;
const scenarioCatalogItemIds = [scenarioContainerCatalogItemId, scenarioContainedCatalogItemId] as const;

type ProductContentSeedServices = Pick<CatalogServices, "db" | "productContents">;

export async function seedProductContentConfiguration(services: ProductContentSeedServices): Promise<void> {
  await services.productContents.upsertContentType({
    contentTypeId: catalogSeedIds.productContentTypes.card,
    key: "card",
    displayName: l10n("Card"),
    sortOrder: 10,
    discoverySearchWeight: 0.7,
  });

  await services.productContents.upsertContentType({
    contentTypeId: catalogSeedIds.productContentTypes.pack,
    key: "pack",
    displayName: l10n("Pack"),
    sortOrder: 20,
    discoverySearchWeight: 0.4,
  });

  await services.productContents.upsertContentType({
    contentTypeId: catalogSeedIds.productContentTypes.accessory,
    key: "accessory",
    displayName: l10n("Accessory"),
    sortOrder: 30,
    discoverySearchWeight: 0.1,
  });

  await services.productContents.upsertContentType({
    contentTypeId: catalogSeedIds.productContentTypes.insertedItem,
    key: "inserted-item",
    displayName: l10n("Inserted item"),
    sortOrder: 40,
    discoverySearchWeight: 0.2,
  });

  await services.productContents.upsertInclusionPolicy({
    inclusionPolicyId: catalogSeedIds.productContentInclusionPolicies.guaranteed,
    key: "guaranteed",
    displayName: l10n("Guaranteed"),
    sortOrder: 10,
  });

  await services.productContents.upsertInclusionPolicy({
    inclusionPolicyId: catalogSeedIds.productContentInclusionPolicies.randomized,
    key: "randomized",
    displayName: l10n("Randomized"),
    sortOrder: 20,
  });

  await services.productContents.upsertInclusionPolicy({
    inclusionPolicyId: catalogSeedIds.productContentInclusionPolicies.variableAssortment,
    key: "variable-assortment",
    displayName: l10n("Variable assortment"),
    sortOrder: 30,
  });

  await services.productContents.upsertInclusionPolicy({
    inclusionPolicyId: catalogSeedIds.productContentInclusionPolicies.optional,
    key: "optional",
    displayName: l10n("Optional"),
    sortOrder: 40,
  });
}

export async function seedProductContentScenario(
  services: ProductContentSeedServices,
  options: Readonly<{ provenanceSource?: "scenario-seed" | "representative-commerce-state" }> = {},
): Promise<boolean> {
  await seedProductContentConfiguration(services);

  if (!(await scenarioCatalogItemsAreProjected(services))) {
    console.log("Catalog Product Contents scenario skipped until scenario Catalog Item projections are available.");
    return false;
  }

  await services.productContents.replaceProductContents(
    {
      containerCatalogItemId: scenarioContainerCatalogItemId,
      lines: [
        {
          containedCatalogItemId: scenarioContainedCatalogItemId,
          quantity: 1,
          contentTypeId: catalogSeedIds.productContentTypes.card,
          inclusionPolicyId: catalogSeedIds.productContentInclusionPolicies.randomized,
          provenance: {
            source: options.provenanceSource ?? "scenario-seed",
            evidence: "representative-product-contents-rollout",
          },
        },
      ],
    },
    seedContext,
  );
  return true;
}

async function scenarioCatalogItemsAreProjected(services: ProductContentSeedServices): Promise<boolean> {
  try {
    const result = await services.db.query<{ catalog_item_id: string }>(
      `SELECT catalog_item_id FROM catalog_items WHERE catalog_item_id = ANY($1::text[])`,
      [scenarioCatalogItemIds],
    );
    const projectedIds = new Set(result.rows.map((row) => row.catalog_item_id));
    return scenarioCatalogItemIds.every((catalogItemId) => projectedIds.has(catalogItemId));
  } catch {
    return false;
  }
}

function l10n(en: string) {
  return {
    defaultLocale: "en",
    values: { en },
  } as const;
}
