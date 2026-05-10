import type { TypedUlid } from "@chase-sets/primitives/typed-ids";

export type SeedCatalogItemId = TypedUlid<"cat">;
export type SeedDimensionId = TypedUlid<"dim">;
export type SeedOptionId = TypedUlid<"chc">;
export type SeedFieldId = TypedUlid<"fld">;
export type SeedComponentId = TypedUlid<"cmp">;
export type SeedBlueprintId = TypedUlid<"bpr">;
export type SeedCategoryId = TypedUlid<"ctg">;

export const catalogSeedIds = {
  dimensions: {
    form: {
      dimensionId: "dim_seed_form" as SeedDimensionId,
      optionIds: {
        raw: "chc_seed_form_raw" as SeedOptionId,
        graded: "chc_seed_form_graded" as SeedOptionId,
      },
    },
    condition: {
      dimensionId: "dim_seed_condition" as SeedDimensionId,
      optionIds: {
        pristine: "chc_seed_condition_pristine" as SeedOptionId,
        mint: "chc_seed_condition_mint" as SeedOptionId,
        nearMint: "chc_seed_condition_near_mint" as SeedOptionId,
        excellent: "chc_seed_condition_excellent" as SeedOptionId,
        good: "chc_seed_condition_good" as SeedOptionId,
        poor: "chc_seed_condition_poor" as SeedOptionId,
        damaged: "chc_seed_condition_damaged" as SeedOptionId,
      },
    },
    gradingCompany: {
      dimensionId: "dim_seed_grading_company" as SeedDimensionId,
      optionIds: {
        psa: "chc_seed_grading_company_psa" as SeedOptionId,
        bgs: "chc_seed_grading_company_bgs" as SeedOptionId,
        cgc: "chc_seed_grading_company_cgc" as SeedOptionId,
        sgc: "chc_seed_grading_company_sgc" as SeedOptionId,
        ace: "chc_seed_grading_company_ace" as SeedOptionId,
        tag: "chc_seed_grading_company_tag" as SeedOptionId,
      },
    },
    grade: {
      dimensionId: "dim_seed_grade" as SeedDimensionId,
      optionIds: {
        pristine10: "chc_seed_grade_pristine_10" as SeedOptionId,
        gemMint10: "chc_seed_grade_gem_mint_10" as SeedOptionId,
        mint95: "chc_seed_grade_mint_95" as SeedOptionId,
        mint9: "chc_seed_grade_mint_9" as SeedOptionId,
        nmMt85: "chc_seed_grade_nm_mt_85" as SeedOptionId,
        nmMt8: "chc_seed_grade_nm_mt_8" as SeedOptionId,
        nm7: "chc_seed_grade_nm_7" as SeedOptionId,
        ex6: "chc_seed_grade_ex_6" as SeedOptionId,
        ex5: "chc_seed_grade_ex_5" as SeedOptionId,
        vg4: "chc_seed_grade_vg_4" as SeedOptionId,
        good3: "chc_seed_grade_good_3" as SeedOptionId,
        good2: "chc_seed_grade_good_2" as SeedOptionId,
        poor1: "chc_seed_grade_poor_1" as SeedOptionId,
      },
    },
  },
  fields: {
    cardNumber: "fld_seed_card_number" as SeedFieldId,
    cardName: "fld_seed_card_name" as SeedFieldId,
    setName: "fld_seed_set_name" as SeedFieldId,
    rarity: "fld_seed_rarity" as SeedFieldId,
    language: "fld_seed_language" as SeedFieldId,
    artist: "fld_seed_artist" as SeedFieldId,
    releaseYear: "fld_seed_release_year" as SeedFieldId,
    packCount: "fld_seed_pack_count" as SeedFieldId,
  },
  components: {
    singleCardIdentity: "cmp_seed_single_card_identity" as SeedComponentId,
    singleCardProductResolution:
      "cmp_seed_single_card_product_resolution" as SeedComponentId,
    sealedProductIdentity: "cmp_seed_sealed_product_identity" as SeedComponentId,
  },
  blueprints: {
    pokemonCardSingle: "bpr_seed_pokemon_card_single" as SeedBlueprintId,
    pokemonSealedProduct: "bpr_seed_pokemon_sealed_product" as SeedBlueprintId,
  },
  categories: {
    pokemonTcg: "ctg_seed_pokemon_tcg" as SeedCategoryId,
    singles: "ctg_seed_singles" as SeedCategoryId,
    sealedProducts: "ctg_seed_sealed_products" as SeedCategoryId,
    boosterPacks: "ctg_seed_booster_packs" as SeedCategoryId,
    boosterBoxes: "ctg_seed_booster_boxes" as SeedCategoryId,
    eliteTrainerBoxes: "ctg_seed_elite_trainer_boxes" as SeedCategoryId,
    byGeneration: "ctg_seed_by_generation" as SeedCategoryId,
    gen1: "ctg_seed_gen_1" as SeedCategoryId,
    gen2: "ctg_seed_gen_2" as SeedCategoryId,
    gen3: "ctg_seed_gen_3" as SeedCategoryId,
    gen4: "ctg_seed_gen_4" as SeedCategoryId,
    gen5: "ctg_seed_gen_5" as SeedCategoryId,
    gen6: "ctg_seed_gen_6" as SeedCategoryId,
    gen7: "ctg_seed_gen_7" as SeedCategoryId,
    gen8: "ctg_seed_gen_8" as SeedCategoryId,
    gen9: "ctg_seed_gen_9" as SeedCategoryId,
    byType: "ctg_seed_by_type" as SeedCategoryId,
    fire: "ctg_seed_type_fire" as SeedCategoryId,
    water: "ctg_seed_type_water" as SeedCategoryId,
    grass: "ctg_seed_type_grass" as SeedCategoryId,
    electric: "ctg_seed_type_electric" as SeedCategoryId,
    psychic: "ctg_seed_type_psychic" as SeedCategoryId,
    fighting: "ctg_seed_type_fighting" as SeedCategoryId,
    dark: "ctg_seed_type_dark" as SeedCategoryId,
    metal: "ctg_seed_type_metal" as SeedCategoryId,
    dragon: "ctg_seed_type_dragon" as SeedCategoryId,
    fairy: "ctg_seed_type_fairy" as SeedCategoryId,
    normal: "ctg_seed_type_normal" as SeedCategoryId,
    colorless: "ctg_seed_type_colorless" as SeedCategoryId,
    trainerCards: "ctg_seed_trainer_cards" as SeedCategoryId,
    energyCards: "ctg_seed_energy_cards" as SeedCategoryId,
  },
  items: {
    charizardBaseSet: "cat_seed_charizard_base_set" as SeedCatalogItemId,
    pikachuJungle: "cat_seed_pikachu_jungle" as SeedCatalogItemId,
    japaneseCharizardBaseSet: "cat_seed_japanese_charizard_base_set" as SeedCatalogItemId,
    lugiaNeoGenesis: "cat_seed_lugia_neo_genesis" as SeedCatalogItemId,
    mewtwoBlackStarPromo: "cat_seed_mewtwo_black_star_promo" as SeedCatalogItemId,
    bulbasaurBaseSet: "cat_seed_bulbasaur_base_set" as SeedCatalogItemId,
    pikachuPrismaticEvolutions: "cat_seed_pikachu_prismatic_evolutions" as SeedCatalogItemId,
    prismaticEvolutionsBoosterPack:
      "cat_seed_prismatic_evolutions_booster_pack" as SeedCatalogItemId,
    surgingSparksBoosterBox:
      "cat_seed_surging_sparks_booster_box" as SeedCatalogItemId,
    twilightMasqueradeEliteTrainerBox:
      "cat_seed_twilight_masquerade_elite_trainer_box" as SeedCatalogItemId,
  },
} as const;
