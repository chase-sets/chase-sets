import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { seedContext } from "../../../support/seed-support/context";
import type { CatalogItemId } from "../../../ids";

export async function seedProductContentConfiguration(services: CatalogServices): Promise<void> {
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

export async function seedProductContentScenario(services: CatalogServices): Promise<void> {
  await seedProductContentConfiguration(services);

  await services.productContents.replaceProductContents(
    {
      containerCatalogItemId: catalogSeedIds.items.prismaticEvolutionsBoosterPack as CatalogItemId,
      lines: [
        {
          containedCatalogItemId: catalogSeedIds.items.pikachuPrismaticEvolutions as CatalogItemId,
          quantity: 1,
          contentTypeId: catalogSeedIds.productContentTypes.card,
          inclusionPolicyId: catalogSeedIds.productContentInclusionPolicies.randomized,
          provenance: {
            source: "scenario-seed",
            evidence: "representative-product-contents-rollout",
          },
        },
      ],
    },
    seedContext,
  );
}

function l10n(en: string) {
  return {
    defaultLocale: "en",
    values: { en },
  } as const;
}
