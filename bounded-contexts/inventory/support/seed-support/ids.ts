import type { TypedUlid } from "@chase-sets/primitives/typed-ids";

export type SeedStorageLocationId = TypedUlid<"loc">;
export type SeedInventoryItemId = TypedUlid<"inv">;
export type SeedInventoryHoldId = TypedUlid<"hld">;

export const inventorySeedIds = {
  storageLocations: {
    northShelf: "loc_seed_north_shelf" as SeedStorageLocationId,
    vaultAnnex: "loc_seed_vault_annex" as SeedStorageLocationId,
    archivedOverflow: "loc_seed_archived_overflow" as SeedStorageLocationId,
    cardVaultBackRoom: "loc_seed_card_vault_back_room" as SeedStorageLocationId,
    sealedCaseWall: "loc_seed_sealed_case_wall" as SeedStorageLocationId,
  },
  items: {
    charizardBaseSetNearMint: "inv_seed_charizard_base_set_nm" as SeedInventoryItemId,
    pikachuJungleLightlyPlayed: "inv_seed_pikachu_jungle_lp" as SeedInventoryItemId,
    lugiaNeoGenesisNearMint: "inv_seed_lugia_neo_genesis_nm" as SeedInventoryItemId,
    mewtwoBlackStarPromoNearMint:
      "inv_seed_mewtwo_black_star_promo_nm" as SeedInventoryItemId,
    pikachuPrismaticEvolutionsNearMint:
      "inv_seed_pikachu_prismatic_evolutions_nm" as SeedInventoryItemId,
    prismaticEvolutionsBoosterPack:
      "inv_seed_prismatic_evolutions_booster_pack" as SeedInventoryItemId,
    surgingSparksBoosterBox:
      "inv_seed_surging_sparks_booster_box" as SeedInventoryItemId,
    twilightMasqueradeEliteTrainerBox:
      "inv_seed_twilight_masquerade_elite_trainer_box" as SeedInventoryItemId,
    cardVaultCharizardNearMint:
      "inv_seed_card_vault_charizard_nm" as SeedInventoryItemId,
    cardVaultPikachuExcellent:
      "inv_seed_card_vault_pikachu_excellent" as SeedInventoryItemId,
    cardVaultMewtwoNearMint:
      "inv_seed_card_vault_mewtwo_nm" as SeedInventoryItemId,
    cardVaultTwilightMasqueradeEliteTrainerBox:
      "inv_seed_card_vault_twilight_masquerade_etb" as SeedInventoryItemId,
    sealedStockroomPrismaticEvolutionsBoosterPack:
      "inv_seed_sealed_seller_prismatic_pack" as SeedInventoryItemId,
    sealedStockroomSurgingSparksBoosterBox:
      "inv_seed_sealed_seller_surging_sparks_box" as SeedInventoryItemId,
    sealedStockroomTwilightMasqueradeEliteTrainerBox:
      "inv_seed_sealed_seller_twilight_masquerade_etb" as SeedInventoryItemId,
  },
  holds: {
    charizardCheckout: "hld_seed_charizard_checkout" as SeedInventoryHoldId,
    pikachuPackingReleased: "hld_seed_pikachu_packing_released" as SeedInventoryHoldId,
    lugiaQualityControl: "hld_seed_lugia_quality_control" as SeedInventoryHoldId,
  },
} as const;
