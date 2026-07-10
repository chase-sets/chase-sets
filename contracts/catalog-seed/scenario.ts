import { catalogSeedIds } from "./ids";

export const catalogScenarioItems = {
  charizardBaseSet: catalogSeedIds.items.charizardBaseSet,
  pikachuJungle: catalogSeedIds.items.pikachuJungle,
  japaneseCharizardBaseSet: catalogSeedIds.items.japaneseCharizardBaseSet,
  lugiaNeoGenesis: catalogSeedIds.items.lugiaNeoGenesis,
  mewtwoBlackStarPromo: catalogSeedIds.items.mewtwoBlackStarPromo,
  bulbasaurBaseSet: catalogSeedIds.items.bulbasaurBaseSet,
  pikachuPrismaticEvolutions: catalogSeedIds.items.pikachuPrismaticEvolutions,
  prismaticEvolutionsBoosterPack: catalogSeedIds.items.prismaticEvolutionsBoosterPack,
  surgingSparksBoosterBox: catalogSeedIds.items.surgingSparksBoosterBox,
  twilightMasqueradeEliteTrainerBox: catalogSeedIds.items.twilightMasqueradeEliteTrainerBox,
  onePieceLuffyRomanceDawn: catalogSeedIds.items.onePieceLuffyRomanceDawn,
  onePieceRomanceDawnBoosterBox: catalogSeedIds.items.onePieceRomanceDawnBoosterBox,
} as const;

export const representativeProductContentsScenario = {
  containerCatalogItemId: catalogScenarioItems.prismaticEvolutionsBoosterPack,
  containedCatalogItemIds: [catalogScenarioItems.pikachuPrismaticEvolutions],
  requiredCatalogItemIds: [
    catalogScenarioItems.prismaticEvolutionsBoosterPack,
    catalogScenarioItems.pikachuPrismaticEvolutions,
  ],
} as const;

export type CatalogScenarioItemAlias = keyof typeof catalogScenarioItems;
