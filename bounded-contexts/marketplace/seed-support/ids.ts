import type { ListingId, OfferId } from "@chase-sets/primitives/typed-ids";

export const marketplaceReservedSeedIds = {
  listings: {
    charizardBaseSetNearMint: "lst_seed_charizard_base_set_nm" as ListingId,
    pikachuJungleLightlyPlayed: "lst_seed_pikachu_jungle_lp" as ListingId,
    lugiaNeoGenesisDraft: "lst_seed_lugia_neo_genesis_draft" as ListingId,
    prismaticEvolutionsPaused: "lst_seed_prismatic_evolutions_paused" as ListingId,
    surgingSparksWithdrawn: "lst_seed_surging_sparks_withdrawn" as ListingId,
    twilightMasqueradeEliteTrainerActive:
      "lst_seed_twilight_masquerade_etb_active" as ListingId,
  },
  offers: {
    charizardBaseSetNearMint: "off_seed_charizard_base_set_nm" as OfferId,
    charizardBaseSetPlayset: "off_seed_charizard_base_set_playset" as OfferId,
    pikachuJungleCollectorLot: "off_seed_pikachu_jungle_collector_lot" as OfferId,
    lugiaNeoGenesisCollector: "off_seed_lugia_neo_genesis_collector" as OfferId,
    pikachuPrismaticEvolutionsModern: "off_seed_pikachu_prismatic_modern" as OfferId,
    prismaticEvolutionsBoosterPackLot: "off_seed_prismatic_pack_lot" as OfferId,
    surgingSparksBoosterBoxRestock: "off_seed_surging_sparks_restock" as OfferId,
    twilightMasqueradeEliteTrainerSubmitted: "off_seed_twilight_masquerade_etb" as OfferId,
  },
} as const;
