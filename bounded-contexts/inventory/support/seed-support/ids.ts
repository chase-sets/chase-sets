import type { TypedUlid } from "@chase-sets/primitives/typed-ids";

export type SeedStorageLocationId = TypedUlid<"loc">;
export type SeedInventoryRecordId = TypedUlid<"inv">;
export type SeedInventoryHoldId = TypedUlid<"hld">;

export const inventorySeedIds = {
  storageLocations: {
    northShelf: "loc_seed_north_shelf" as SeedStorageLocationId,
    vaultAnnex: "loc_seed_vault_annex" as SeedStorageLocationId,
    archivedOverflow: "loc_seed_archived_overflow" as SeedStorageLocationId,
  },
  records: {
    charizardBaseSetNearMint: "inv_seed_charizard_base_set_nm" as SeedInventoryRecordId,
    pikachuJungleLightlyPlayed: "inv_seed_pikachu_jungle_lp" as SeedInventoryRecordId,
    lugiaNeoGenesisNearMint: "inv_seed_lugia_neo_genesis_nm" as SeedInventoryRecordId,
    pikachuPrismaticEvolutionsNearMint:
      "inv_seed_pikachu_prismatic_evolutions_nm" as SeedInventoryRecordId,
    prismaticEvolutionsBoosterPack:
      "inv_seed_prismatic_evolutions_booster_pack" as SeedInventoryRecordId,
    surgingSparksBoosterBox:
      "inv_seed_surging_sparks_booster_box" as SeedInventoryRecordId,
    twilightMasqueradeEliteTrainerBox:
      "inv_seed_twilight_masquerade_elite_trainer_box" as SeedInventoryRecordId,
  },
  holds: {
    charizardCheckout: "hld_seed_charizard_checkout" as SeedInventoryHoldId,
    pikachuPackingReleased: "hld_seed_pikachu_packing_released" as SeedInventoryHoldId,
    lugiaQualityControl: "hld_seed_lugia_quality_control" as SeedInventoryHoldId,
  },
} as const;
