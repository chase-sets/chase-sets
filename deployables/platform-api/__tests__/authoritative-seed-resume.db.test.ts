import type {
  BcApiModule,
  BcProjectionHandlerSet,
  BcSeedAggregateStateReport,
  BcSeedOptions,
} from "@chase-sets/bounded-context-module";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  countEventsWithPrefix,
  createCheckpointKey,
  loadSubscriptionCheckpoint,
  seedProfilesOverlap,
} from "@chase-sets/bounded-context-runtime";
import {
  getApiHostEntries,
  getApiHostSeedOrder,
  seedApiHostIfEmpty,
  type ApiContextManifest,
  type ApiHostRuntime,
} from "@chase-sets/platform-runtime/api";
import type { PlatformApiRuntimeProfile } from "@chase-sets/platform-runtime/runtime-profiles";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
// Deployables may only consume a context's public entrypoints, so a
// `seed-support/*` import is a structure-gate violation here. Identity
// re-exports its seed ids through its public `server` entrypoint, so bind to
// that; Payments and Settlement do not, so their two ids are inlined below the
// same way this file already inlines `requiredDraftListingId`. Each inlined id
// is guarded by an assertion that fails loudly if the seed renames it.
import { identitySeedIds } from "@chase-sets/identity/server";
import { describe, expect, it } from "vitest";
import { createPlatformApiHost } from "../src/app";
import type { PlatformApiContextName } from "../src/config";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import {
  createPlatformApiBootstrapTestHarness,
  createPlatformApiRetainedStateHandoff,
  listingPhotoStorage,
  platformApiContextNames,
  RETAINED_STATE_HANDOFF_ERROR,
  type PlatformApiTestPools,
} from "./bootstrap-db-test-support";

/**
 * DB-tier coverage for #4906 and #6396 across the derived scenario-seed
 * universe: a seed must decide what remains to author from its authoritative
 * `event_store_events` streams, never from a read model that lags — whether
 * because PostgreSQL truncated an UNLOGGED projection on crash recovery or
 * because the projection that fills it is simply behind the stream.
 *
 * Context membership is never hand-written here. Every context list this file
 * asserts on is derived from `apiContextRegistry` through the runtime's own
 * `getApiHostEntries` / mount-role selection, and the prose tables recorded on
 * #6396 are checked against that derived set as diagnostics.
 */
const HOST_NAME = "platform-api";
const SETTLEMENT_PAYOUT_PROJECTION_NAME = "settlement-payout-projection";
const PREDECESSOR_REAUTHOR_ERROR = "PREDECESSOR_WOULD_REAUTHOR_SETTLEMENT";
const registryContextNames = apiContextRegistry.map((entry) => entry.contextName);

/**
 * The #4906 UNLOGGED-truncation fixture. This is deliberately *not* the
 * coverage authority — it is the explicit list of read-model tables this file
 * truncates to prove crash-recovery resume, and it is validated below against
 * the derived inspecting set so it can never name a context that stopped
 * inspecting. The confirmed inventory failure and the resume/fail-closed
 * controls live in the cheaper `inventory-seed-resume.db.test.ts` partition;
 * Catalog's lagging-projection coverage lives in
 * `catalog-seed-aggregate-state.db.test.ts` and is not rebuilt here.
 */
const unloggedGuardProjectionFixture = [
  {
    contextName: "inventory",
    projections: ["inventory_holds", "inventory_items", "inventory_storage_locations"],
  },
  { contextName: "identity", projections: ["identity_accounts"] },
  {
    contextName: "marketplace",
    projections: ["marketplace_review_pages", "marketplace_offer_pages", "marketplace_listing_pages"],
  },
  { contextName: "payments", projections: ["payments_payment_pages"] },
  { contextName: "settlement", projections: ["settlement_payout_pages"] },
  { contextName: "fulfillment", projections: ["fulfillment_shipment_pages"] },
  { contextName: "checkout", projections: ["checkout_cart_line_pages", "checkout_session_pages"] },
  { contextName: "ordering", projections: ["ordering_order_pages", "ordering_postage_policy_pages"] },
  {
    contextName: "platform-operations",
    projections: ["experience_platform_feedback_pages", "support_request_pages"],
  },
] as const satisfies readonly Readonly<{ contextName: PlatformApiContextName; projections: readonly string[] }>[];

/**
 * Mounted contexts that seed but deliberately declare no stream-sourced seed
 * state, with the reason. A newly mounted seeding context is a coverage
 * omission unless it is added here on purpose, which is what makes the
 * enumeration below fail loudly rather than silently shrink.
 */
const seedStateExemptions = new Map<string, string>([
  ["pricing", "seed is a no-op; it authors no aggregate"],
  ["commercial-terms", "authors logged platform-policy documents, not UNLOGGED projections"],
  ["public-presence", "authors logged platform-policy documents and promo-bar rows, not UNLOGGED projections"],
]);

type MountRole = "active" | "source-only";
type ProfileUniverse = Readonly<{
  active: readonly string[];
  sourceOnly: readonly string[];
  omitted: readonly string[];
}>;

/**
 * Profile universes frozen on #6396. These are diagnostics: every one of them
 * is compared against the set derived from the executable manifests below, and
 * the derivation — not this table — is the authority.
 */
const frozenProfileDiagnostics: Readonly<Record<string, ProfileUniverse>> = {
  undefined: {
    active: [
      "auth",
      "authenticity",
      "catalog",
      "checkout",
      "collections",
      "commercial-terms",
      "customer-feedback",
      "discovery",
      "fulfillment",
      "identity",
      "inventory",
      "marketplace",
      "notifications",
      "ordering",
      "payments",
      "platform-operations",
      "pricing",
      "public-presence",
      "settlement",
    ],
    sourceOnly: [],
    omitted: [],
  },
  proof: {
    active: [
      "auth",
      "authenticity",
      "catalog",
      "checkout",
      "collections",
      "commercial-terms",
      "customer-feedback",
      "discovery",
      "fulfillment",
      "identity",
      "inventory",
      "marketplace",
      "notifications",
      "ordering",
      "payments",
      "platform-operations",
      "pricing",
      "public-presence",
      "settlement",
    ],
    sourceOnly: [],
    omitted: [],
  },
  public: {
    active: [
      "auth",
      "authenticity",
      "catalog",
      "checkout",
      "collections",
      "commercial-terms",
      "customer-feedback",
      "discovery",
      "fulfillment",
      "identity",
      "inventory",
      "marketplace",
      "notifications",
      "ordering",
      "payments",
      "platform-operations",
      "pricing",
      "public-presence",
      "settlement",
    ],
    sourceOnly: [],
    omitted: [],
  },
  landing: {
    active: ["auth", "catalog", "identity", "platform-operations", "public-presence"],
    sourceOnly: ["commercial-terms", "fulfillment", "marketplace", "ordering", "settlement"],
    omitted: [
      "authenticity",
      "checkout",
      "collections",
      "customer-feedback",
      "discovery",
      "inventory",
      "notifications",
      "payments",
      "pricing",
    ],
  },
};

/**
 * The exact `undefined` + `scenario-seed` eligible universe recorded on #6396,
 * checked below against `seedProfilesOverlap` over the mounted modules.
 */
const frozenEligibleScenarioSeedContexts = [
  "auth",
  "catalog",
  "checkout",
  "commercial-terms",
  "fulfillment",
  "identity",
  "inventory",
  "marketplace",
  "ordering",
  "payments",
  "platform-operations",
  "pricing",
  "public-presence",
  "settlement",
] as const;

/** The contexts that expose `inspectSeedState`, per #6396. */
const frozenInspectingSeedContexts = [
  "auth",
  "catalog",
  "checkout",
  "fulfillment",
  "identity",
  "inventory",
  "marketplace",
  "ordering",
  "payments",
  "platform-operations",
  "settlement",
] as const;

/** Eligible contexts that deliberately expose no `inspectSeedState`. */
const frozenNonInspectingSeedContexts = ["commercial-terms", "pricing", "public-presence"] as const;

/**
 * The exact inspector implementation each context's reports come from. This is
 * the derivation source for the pinned identity corpus below: the corpus is not
 * derivable from any public repo surface a deployable may import (`check-
 * structure` forbids importing a context's `seed-support/*`), so it is pinned,
 * and the artifact this file publishes names the implementation each pinned
 * identity was read from. Ownership and event counts are *not* pinned — they are
 * bound to the mounted module and to `event_store_events` below, which is what
 * makes the identity pin safe to trust.
 */
const seedInspectorDerivationSources: Readonly<Record<string, string>> = {
  auth: "bounded-contexts/auth/support/runtime-support/seed.ts inspectAuthSeedState",
  catalog: "bounded-contexts/catalog/support/seed-support/catalog-integration-state.ts inspectCatalogSeedState",
  checkout: "bounded-contexts/checkout/support/runtime-support/seed.ts inspectCheckoutSeedState",
  fulfillment: "bounded-contexts/fulfillment/support/runtime-support/seed.ts inspectFulfillmentSeedState",
  identity: "bounded-contexts/identity/support/runtime-support/seed.ts inspectIdentitySeedState",
  inventory: "bounded-contexts/inventory/support/runtime-support/seed.ts inspectInventorySeedState",
  marketplace: "bounded-contexts/marketplace/support/runtime-support/seed.ts inspectMarketplaceSeedState",
  ordering: "bounded-contexts/ordering/support/runtime-support/seed.ts inspectOrderingSeedState",
  payments: "bounded-contexts/payments/support/runtime-support/seed.ts inspectPaymentsSeedState",
  "platform-operations":
    "bounded-contexts/platform-operations/support/runtime-support/seed.ts inspectPlatformOperationsSeedState",
  settlement: "bounded-contexts/settlement/support/runtime-support/seed.ts inspectSettlementSeedState",
};

/**
 * The pinned expected identity corpus: one `contextName|aggregateName|id|key`
 * row per report every inspecting context must produce after a completed
 * scenario-seed boot, sorted. Both the exact set and its cardinality are
 * asserted, so a dropped, renamed, or added seed aggregate fails this file.
 */
const frozenSeedIdentityCorpus: readonly string[] = [
  "auth|Session|ses_seed_collector_session|collector",
  "auth|Session|ses_seed_demo_session|demo",
  "auth|Session|ses_seed_support_session|support",
  "catalog|Blueprint|bpr_seed_lorcana_card_print|lorcana-card-print",
  "catalog|Blueprint|bpr_seed_lorcana_sealed_product|lorcana-sealed-product",
  "catalog|Blueprint|bpr_seed_magic_card_print|magic-card-print",
  "catalog|Blueprint|bpr_seed_magic_sealed_product|magic-sealed-product",
  "catalog|Blueprint|bpr_seed_one_piece_card_print|one-piece-card-print",
  "catalog|Blueprint|bpr_seed_one_piece_sealed_product|one-piece-sealed-product",
  "catalog|Blueprint|bpr_seed_pokemon_card_single|pokemon-card-single",
  "catalog|Blueprint|bpr_seed_pokemon_sealed_product|pokemon-sealed-product",
  "catalog|Category|ctg_seed_booster_boxes|booster-boxes",
  "catalog|Category|ctg_seed_booster_packs|booster-packs",
  "catalog|Category|ctg_seed_by_generation|by-generation",
  "catalog|Category|ctg_seed_by_type|by-type",
  "catalog|Category|ctg_seed_elite_trainer_boxes|elite-trainer-boxes",
  "catalog|Category|ctg_seed_energy_cards|energy-cards",
  "catalog|Category|ctg_seed_gen_1|gen-1",
  "catalog|Category|ctg_seed_gen_2|gen-2",
  "catalog|Category|ctg_seed_gen_3|gen-3",
  "catalog|Category|ctg_seed_gen_4|gen-4",
  "catalog|Category|ctg_seed_gen_5|gen-5",
  "catalog|Category|ctg_seed_gen_6|gen-6",
  "catalog|Category|ctg_seed_gen_7|gen-7",
  "catalog|Category|ctg_seed_gen_8|gen-8",
  "catalog|Category|ctg_seed_gen_9|gen-9",
  "catalog|Category|ctg_seed_lorcana_booster_boxes|lorcana-booster-boxes",
  "catalog|Category|ctg_seed_lorcana_booster_cases|lorcana-booster-cases",
  "catalog|Category|ctg_seed_lorcana_booster_packs|lorcana-booster-packs",
  "catalog|Category|ctg_seed_lorcana_card_prints|lorcana-card-prints",
  "catalog|Category|ctg_seed_lorcana_collection_starters|lorcana-collection-starters",
  "catalog|Category|ctg_seed_lorcana_gift_sets|lorcana-gift-sets",
  "catalog|Category|ctg_seed_lorcana_prerelease_boxes|lorcana-prerelease-boxes",
  "catalog|Category|ctg_seed_lorcana_quests_and_product_bundles|lorcana-quests-and-product-bundles",
  "catalog|Category|ctg_seed_lorcana_sealed_products|lorcana-sealed-products",
  "catalog|Category|ctg_seed_lorcana_sets|lorcana-sets",
  "catalog|Category|ctg_seed_lorcana_sleeved_boosters|lorcana-sleeved-boosters",
  "catalog|Category|ctg_seed_lorcana_special_sets|lorcana-special-sets",
  "catalog|Category|ctg_seed_lorcana_starter_decks|lorcana-starter-decks",
  "catalog|Category|ctg_seed_lorcana_troves|lorcana-troves",
  "catalog|Category|ctg_seed_lorcana|lorcana",
  "catalog|Category|ctg_seed_magic_booster_boxes|magic-booster-boxes",
  "catalog|Category|ctg_seed_magic_booster_packs|magic-booster-packs",
  "catalog|Category|ctg_seed_magic_card_prints|magic-card-prints",
  "catalog|Category|ctg_seed_magic_sealed_products|magic-sealed-products",
  "catalog|Category|ctg_seed_magic_the_gathering|magic-the-gathering",
  "catalog|Category|ctg_seed_one_piece_booster_boxes|one-piece-booster-boxes",
  "catalog|Category|ctg_seed_one_piece_booster_packs|one-piece-booster-packs",
  "catalog|Category|ctg_seed_one_piece_card_game|one-piece-card-game",
  "catalog|Category|ctg_seed_one_piece_card_prints|one-piece-card-prints",
  "catalog|Category|ctg_seed_one_piece_sealed_products|one-piece-sealed-products",
  "catalog|Category|ctg_seed_one_piece_starter_decks|one-piece-starter-decks",
  "catalog|Category|ctg_seed_pokemon_tcg|pokemon-tcg",
  "catalog|Category|ctg_seed_sealed_products|sealed-products",
  "catalog|Category|ctg_seed_singles|singles",
  "catalog|Category|ctg_seed_trainer_cards|trainer-cards",
  "catalog|Category|ctg_seed_type_colorless|colorless",
  "catalog|Category|ctg_seed_type_dark|dark",
  "catalog|Category|ctg_seed_type_dragon|dragon",
  "catalog|Category|ctg_seed_type_electric|electric",
  "catalog|Category|ctg_seed_type_fairy|fairy",
  "catalog|Category|ctg_seed_type_fighting|fighting",
  "catalog|Category|ctg_seed_type_fire|fire",
  "catalog|Category|ctg_seed_type_grass|grass",
  "catalog|Category|ctg_seed_type_metal|metal",
  "catalog|Category|ctg_seed_type_normal|normal",
  "catalog|Category|ctg_seed_type_psychic|psychic",
  "catalog|Category|ctg_seed_type_water|water",
  "catalog|Component|cmp_seed_lorcana_card_print_identity|lorcana-card-print-identity",
  "catalog|Component|cmp_seed_lorcana_card_product_resolution|lorcana-card-product-resolution",
  "catalog|Component|cmp_seed_lorcana_sealed_product_identity|lorcana-sealed-product-identity",
  "catalog|Component|cmp_seed_magic_card_print_identity|magic-card-print-identity",
  "catalog|Component|cmp_seed_magic_card_product_resolution|magic-card-product-resolution",
  "catalog|Component|cmp_seed_magic_sealed_product_identity|magic-sealed-product-identity",
  "catalog|Component|cmp_seed_one_piece_card_print_identity|one-piece-card-print-identity",
  "catalog|Component|cmp_seed_one_piece_card_product_resolution|one-piece-card-product-resolution",
  "catalog|Component|cmp_seed_one_piece_sealed_product_identity|one-piece-sealed-product-identity",
  "catalog|Component|cmp_seed_sealed_product_identity|sealed-product-identity",
  "catalog|Component|cmp_seed_single_card_identity|single-card-identity",
  "catalog|Component|cmp_seed_single_card_product_resolution|single-card-product-resolution",
  "catalog|Dimension|dim_seed_condition|condition",
  "catalog|Dimension|dim_seed_form|form",
  "catalog|Dimension|dim_seed_grade|grade",
  "catalog|Dimension|dim_seed_grading_company|grading-company",
  "catalog|Field|fld_seed_card_classifications|card-classifications",
  "catalog|Field|fld_seed_card_illustrator|card-illustrator",
  "catalog|Field|fld_seed_card_name|card-name",
  "catalog|Field|fld_seed_card_number|card-number",
  "catalog|Field|fld_seed_card_properties|card-properties",
  "catalog|Field|fld_seed_card_type|card-type",
  "catalog|Field|fld_seed_card_variant|card-variant",
  "catalog|Field|fld_seed_expansion|expansion",
  "catalog|Field|fld_seed_ink_color|ink-color",
  "catalog|Field|fld_seed_pack_count|pack-count",
  "catalog|Field|fld_seed_product_kind|product-kind",
  "catalog|Field|fld_seed_publisher|publisher",
  "catalog|Field|fld_seed_rarity|rarity",
  "catalog|Field|fld_seed_release_year|release-year",
  "catalog|Field|fld_seed_sealed_product_form|sealed-product-form",
  "catalog|Field|fld_seed_sealed_product_name|sealed-product-name",
  "catalog|Field|fld_seed_sealed_product_number|sealed-product-number",
  "catalog|Field|fld_seed_set_code|set-code",
  "catalog|Field|fld_seed_set_name|set-name",
  "catalog|Field|fld_seed_set_type|set-type",
  "catalog|Field|fld_seed_set|set",
  "catalog|Reference Record|ref_seed_bandai|bandai",
  "catalog|Reference Record|ref_seed_disney_lorcana|disney-lorcana",
  "catalog|Reference Record|ref_seed_expansion_base_set|base-set",
  "catalog|Reference Record|ref_seed_expansion_jungle|jungle",
  "catalog|Reference Record|ref_seed_expansion_neo_genesis|neo-genesis",
  "catalog|Reference Record|ref_seed_expansion_prismatic_evolutions|prismatic-evolutions",
  "catalog|Reference Record|ref_seed_expansion_surging_sparks|surging-sparks",
  "catalog|Reference Record|ref_seed_expansion_twilight_masquerade|twilight-masquerade",
  "catalog|Reference Record|ref_seed_expansion_wizards_black_star_promos|wizards-black-star-promos",
  "catalog|Reference Record|ref_seed_magic_the_gathering|magic-the-gathering",
  "catalog|Reference Record|ref_seed_one_piece_card_game|one-piece-card-game",
  "catalog|Reference Record|ref_seed_pokemon_trading_card_game|pokemon-trading-card-game",
  "catalog|Reference Record|ref_seed_ravensburger|ravensburger",
  "catalog|Reference Record|ref_seed_series_base|base",
  "catalog|Reference Record|ref_seed_series_neo|neo",
  "catalog|Reference Record|ref_seed_series_scarlet_violet|scarlet-violet",
  "catalog|Reference Record|ref_seed_series_wizards_black_star_promos|wizards-black-star-promos",
  "catalog|Reference Record|ref_seed_set_lorcana_d23_collection|d23-collection",
  "catalog|Reference Record|ref_seed_set_lorcana_the_first_chapter|the-first-chapter",
  "catalog|Reference Record|ref_seed_set_one_piece_romance_dawn|romance-dawn",
  "catalog|Reference Record|ref_seed_set_time_spiral|time-spiral",
  "catalog|Reference Record|ref_seed_the_pokemon_company_international|the-pokemon-company-international",
  "catalog|Reference Record|ref_seed_wizards_of_the_coast|wizards-of-the-coast",
  "catalog|Reference Type|rft_seed_expansion|expansion",
  "catalog|Reference Type|rft_seed_manufacturer|manufacturer",
  "catalog|Reference Type|rft_seed_product_line|product-line",
  "catalog|Reference Type|rft_seed_series|series",
  "catalog|Reference Type|rft_seed_set|set",
  "checkout|Cart Line|cli_seed_demo_charizard_base_set_near_mint|lst_seed_charizard_base_set_nm",
  "checkout|Cart Line|cli_seed_demo_pikachu_jungle_excellent|lst_seed_pikachu_jungle_lp",
  "checkout|Checkout Session|chk_seed_started_cart|started-cart",
  "fulfillment|Shipment|shp_seed_awaiting_label|1ZSEEDAWAITINGLABEL",
  "fulfillment|Shipment|shp_seed_demo_charizard|1ZSEEDDELIVERED",
  "fulfillment|Shipment|shp_seed_dispatched|1ZSEEDDISPATCHED",
  "fulfillment|Shipment|shp_seed_exception|1ZSEEDEXCEPTION",
  "fulfillment|Shipment|shp_seed_label_attached|1ZSEEDLABELATTACHED",
  "fulfillment|Shipment|shp_seed_returned|1ZSEEDRETURNED",
  "fulfillment|Shipment|shp_seed_review_eligible|1ZSEEDREVIEWELIGIBLE",
  "identity|API Key|key_seed_demo_primary|sk_seed_demo_primary",
  "identity|API Key|key_seed_rotated_revoked|sk_seed_demo_rotated",
  "identity|Account|acc_seed_card_vault_account|Card Vault",
  "identity|Account|acc_seed_collector_account|Demo Collector",
  "identity|Account|acc_seed_demo_account|Demo Account",
  "identity|Account|acc_seed_high_roller_trader_account|High Roller Trader",
  "identity|Account|acc_seed_sealed_stockroom_account|Sealed Stockroom",
  "identity|Account|acc_seed_support_account|Support Ops",
  "identity|Account|acc_seed_suspended_account|Dormant Account",
  "identity|Account|acc_seed_value_trader_account|Value Trader",
  "identity|Consent|cns_seed_card_vault_terms|terms-of-service usr_seed_card_vault_user",
  "identity|Consent|cns_seed_collector_terms|terms-of-service usr_seed_collector_user",
  "identity|Consent|cns_seed_demo_terms|terms-of-service usr_seed_demo_user",
  "identity|Consent|cns_seed_high_roller_trader_terms|terms-of-service usr_seed_high_roller_trader_user",
  "identity|Consent|cns_seed_sealed_stockroom_terms|terms-of-service usr_seed_sealed_stockroom_user",
  "identity|Consent|cns_seed_value_trader_terms|terms-of-service usr_seed_value_trader_user",
  "identity|Invitation|ivt_seed_cancelled|cancelled@chasesets.test",
  "identity|Invitation|ivt_seed_declined|declined@chasesets.test",
  "identity|Invitation|ivt_seed_expired|expired@chasesets.test",
  "identity|Invitation|ivt_seed_support_accept|support@chasesets.test",
  "identity|Membership|mbr_seed_card_vault_membership|Card Vault owner",
  "identity|Membership|mbr_seed_collector_membership|Demo Collector owner",
  "identity|Membership|mbr_seed_demo_membership|Demo Account owner",
  "identity|Membership|mbr_seed_high_roller_trader_membership|High Roller Trader owner",
  "identity|Membership|mbr_seed_sealed_stockroom_membership|Sealed Stockroom owner",
  "identity|Membership|mbr_seed_support_membership|Support Ops manager",
  "identity|Membership|mbr_seed_suspended_membership|Dormant Account owner",
  "identity|Membership|mbr_seed_value_trader_membership|Value Trader owner",
  "identity|Shipping Address Book|acc_seed_collector_account|Home",
  "identity|Shipping Address Book|acc_seed_demo_account|Office receiving",
  "identity|User|usr_seed_card_vault_user|card-vault@chasesets.test",
  "identity|User|usr_seed_collector_user|collector@chasesets.test",
  "identity|User|usr_seed_demo_user|demo@chasesets.test",
  "identity|User|usr_seed_high_roller_trader_user|high-roller@chasesets.test",
  "identity|User|usr_seed_sealed_stockroom_user|sealed-stockroom@chasesets.test",
  "identity|User|usr_seed_support_user|support@chasesets.test",
  "identity|User|usr_seed_suspended_user|suspended@chasesets.test",
  "identity|User|usr_seed_value_trader_user|value-trader@chasesets.test",
  "inventory|Inventory Hold|hld_seed_charizard_checkout|hld_seed_charizard_checkout",
  "inventory|Inventory Hold|hld_seed_lugia_quality_control|hld_seed_lugia_quality_control",
  "inventory|Inventory Hold|hld_seed_pikachu_packing_released|hld_seed_pikachu_packing_released",
  "inventory|Inventory Item|inv_seed_card_vault_charizard_nm|inv_seed_card_vault_charizard_nm",
  "inventory|Inventory Item|inv_seed_card_vault_charizard_psa_8|inv_seed_card_vault_charizard_psa_8",
  "inventory|Inventory Item|inv_seed_card_vault_mewtwo_nm|inv_seed_card_vault_mewtwo_nm",
  "inventory|Inventory Item|inv_seed_card_vault_pikachu_excellent|inv_seed_card_vault_pikachu_excellent",
  "inventory|Inventory Item|inv_seed_card_vault_twilight_masquerade_etb|inv_seed_card_vault_twilight_masquerade_etb",
  "inventory|Inventory Item|inv_seed_charizard_base_set_nm|inv_seed_charizard_base_set_nm",
  "inventory|Inventory Item|inv_seed_charizard_base_set_psa_8|inv_seed_charizard_base_set_psa_8",
  "inventory|Inventory Item|inv_seed_lugia_neo_genesis_bgs_95|inv_seed_lugia_neo_genesis_bgs_95",
  "inventory|Inventory Item|inv_seed_lugia_neo_genesis_nm|inv_seed_lugia_neo_genesis_nm",
  "inventory|Inventory Item|inv_seed_mewtwo_black_star_promo_nm|inv_seed_mewtwo_black_star_promo_nm",
  "inventory|Inventory Item|inv_seed_pikachu_jungle_lp|inv_seed_pikachu_jungle_lp",
  "inventory|Inventory Item|inv_seed_pikachu_prismatic_evolutions_nm|inv_seed_pikachu_prismatic_evolutions_nm",
  "inventory|Inventory Item|inv_seed_pikachu_prismatic_evolutions_psa_10|inv_seed_pikachu_prismatic_evolutions_psa_10",
  "inventory|Inventory Item|inv_seed_prismatic_evolutions_booster_pack|inv_seed_prismatic_evolutions_booster_pack",
  "inventory|Inventory Item|inv_seed_sealed_seller_prismatic_pack|inv_seed_sealed_seller_prismatic_pack",
  "inventory|Inventory Item|inv_seed_sealed_seller_surging_sparks_box|inv_seed_sealed_seller_surging_sparks_box",
  "inventory|Inventory Item|inv_seed_sealed_seller_twilight_masquerade_etb|inv_seed_sealed_seller_twilight_masquerade_etb",
  "inventory|Inventory Item|inv_seed_surging_sparks_booster_box|inv_seed_surging_sparks_booster_box",
  "inventory|Inventory Item|inv_seed_twilight_masquerade_elite_trainer_box|inv_seed_twilight_masquerade_elite_trainer_box",
  "inventory|Storage Location|loc_seed_archived_overflow|CHI-OLD-9",
  "inventory|Storage Location|loc_seed_card_vault_back_room|STL-VAULT-4",
  "inventory|Storage Location|loc_seed_north_shelf|CHI-WH-1",
  "inventory|Storage Location|loc_seed_sealed_case_wall|IND-CASE-2",
  "inventory|Storage Location|loc_seed_vault_annex|CHI-ANNEX-2",
  "marketplace|Listing|lst_seed_card_vault_charizard_market_maker|inv_seed_card_vault_charizard_nm",
  "marketplace|Listing|lst_seed_card_vault_charizard_nm|inv_seed_card_vault_charizard_nm",
  "marketplace|Listing|lst_seed_card_vault_charizard_psa_8|inv_seed_card_vault_charizard_psa_8",
  "marketplace|Listing|lst_seed_card_vault_mewtwo_budget|inv_seed_card_vault_mewtwo_nm",
  "marketplace|Listing|lst_seed_card_vault_pikachu_low_margin|inv_seed_card_vault_pikachu_excellent",
  "marketplace|Listing|lst_seed_card_vault_pikachu_stack|inv_seed_card_vault_pikachu_excellent",
  "marketplace|Listing|lst_seed_card_vault_twilight_masquerade_etb|inv_seed_card_vault_twilight_masquerade_etb",
  "marketplace|Listing|lst_seed_charizard_base_set_nm|inv_seed_charizard_base_set_nm",
  "marketplace|Listing|lst_seed_charizard_base_set_psa_8|inv_seed_charizard_base_set_psa_8",
  "marketplace|Listing|lst_seed_lugia_neo_genesis_bgs_95|inv_seed_lugia_neo_genesis_bgs_95",
  "marketplace|Listing|lst_seed_lugia_neo_genesis_draft|inv_seed_lugia_neo_genesis_nm",
  "marketplace|Listing|lst_seed_mewtwo_black_star_promo_active|inv_seed_mewtwo_black_star_promo_nm",
  "marketplace|Listing|lst_seed_mewtwo_black_star_promo_premium|inv_seed_mewtwo_black_star_promo_nm",
  "marketplace|Listing|lst_seed_pikachu_jungle_lp|inv_seed_pikachu_jungle_lp",
  "marketplace|Listing|lst_seed_pikachu_jungle_premium_copy|inv_seed_pikachu_jungle_lp",
  "marketplace|Listing|lst_seed_pikachu_jungle_value_copy|inv_seed_pikachu_jungle_lp",
  "marketplace|Listing|lst_seed_pikachu_prismatic_psa_10|inv_seed_pikachu_prismatic_evolutions_psa_10",
  "marketplace|Listing|lst_seed_prismatic_evolutions_paused|inv_seed_pikachu_prismatic_evolutions_nm",
  "marketplace|Listing|lst_seed_sealed_seller_surging_sparks_active|inv_seed_sealed_seller_surging_sparks_box",
  "marketplace|Listing|lst_seed_sealed_seller_surging_sparks_premium|inv_seed_sealed_seller_surging_sparks_box",
  "marketplace|Listing|lst_seed_sealed_seller_twilight_masquerade_etb|inv_seed_sealed_seller_twilight_masquerade_etb",
  "marketplace|Listing|lst_seed_surging_sparks_withdrawn|inv_seed_surging_sparks_booster_box",
  "marketplace|Listing|lst_seed_twilight_masquerade_etb_active|inv_seed_twilight_masquerade_elite_trainer_box",
  "marketplace|Offer|off_seed_charizard_base_set_high_roller|cat_seed_charizard_base_set",
  "marketplace|Offer|off_seed_charizard_base_set_nm|cat_seed_charizard_base_set",
  "marketplace|Offer|off_seed_charizard_base_set_playset|cat_seed_charizard_base_set",
  "marketplace|Offer|off_seed_charizard_base_set_value_trader|cat_seed_charizard_base_set",
  "marketplace|Offer|off_seed_lugia_neo_genesis_collector|cat_seed_lugia_neo_genesis",
  "marketplace|Offer|off_seed_lugia_neo_genesis_high_roller|cat_seed_lugia_neo_genesis",
  "marketplace|Offer|off_seed_lugia_neo_genesis_value_trader|cat_seed_lugia_neo_genesis",
  "marketplace|Offer|off_seed_pikachu_jungle_binder_fill|cat_seed_pikachu_jungle",
  "marketplace|Offer|off_seed_pikachu_jungle_bulk_restock|cat_seed_pikachu_jungle",
  "marketplace|Offer|off_seed_pikachu_jungle_collector_lot|cat_seed_pikachu_jungle",
  "marketplace|Offer|off_seed_pikachu_jungle_floor_bid|cat_seed_pikachu_jungle",
  "marketplace|Offer|off_seed_pikachu_jungle_high_velocity_lot|cat_seed_pikachu_jungle",
  "marketplace|Offer|off_seed_pikachu_jungle_quick_sale|cat_seed_pikachu_jungle",
  "marketplace|Offer|off_seed_pikachu_prismatic_binder|cat_seed_pikachu_prismatic_evolutions",
  "marketplace|Offer|off_seed_pikachu_prismatic_modern|cat_seed_pikachu_prismatic_evolutions",
  "marketplace|Offer|off_seed_prismatic_pack_case_break|cat_seed_prismatic_evolutions_booster_pack",
  "marketplace|Offer|off_seed_prismatic_pack_floor|cat_seed_prismatic_evolutions_booster_pack",
  "marketplace|Offer|off_seed_prismatic_pack_lot|cat_seed_prismatic_evolutions_booster_pack",
  "marketplace|Offer|off_seed_prismatic_pack_micro_lot|cat_seed_prismatic_evolutions_booster_pack",
  "marketplace|Offer|off_seed_surging_sparks_case_bid|cat_seed_surging_sparks_booster_box",
  "marketplace|Offer|off_seed_surging_sparks_restock|cat_seed_surging_sparks_booster_box",
  "marketplace|Offer|off_seed_surging_sparks_value_bid|cat_seed_surging_sparks_booster_box",
  "marketplace|Offer|off_seed_twilight_masquerade_etb_bundle|cat_seed_twilight_masquerade_elite_trainer_box",
  "marketplace|Offer|off_seed_twilight_masquerade_etb_encore|cat_seed_twilight_masquerade_elite_trainer_box",
  "marketplace|Offer|off_seed_twilight_masquerade_etb_floor|cat_seed_twilight_masquerade_elite_trainer_box",
  "marketplace|Offer|off_seed_twilight_masquerade_etb|cat_seed_twilight_masquerade_elite_trainer_box",
  "marketplace|Review|rev_seed_buyer_to_seller_active|buyer-to-seller-active",
  "marketplace|Review|rev_seed_seller_to_buyer_withdrawn|seller-to-buyer-withdrawn",
  "ordering|Order|ord_seed_cancelled|chk_seed_cancelled",
  "ordering|Order|ord_seed_checkout_pending|chk_seed_checkout_pending",
  "ordering|Order|ord_seed_offer_ready|off_seed_twilight_masquerade_etb",
  "ordering|Order|ord_seed_review_eligible|off_seed_twilight_masquerade_etb_encore",
  "ordering|Postage Policy|opp_seed_default|Default postage policy",
  "payments|Payment|pay_seed_cancelled_vintage_checkout|cancelled-vintage-checkout",
  "payments|Payment|pay_seed_checkout_pending|checkout-pending",
  "payments|Payment|pay_seed_failed_modern_checkout|failed-modern-checkout",
  "payments|Payment|pay_seed_offer_captured|accepted-offer-captured",
  "payments|Payment|pay_seed_review_eligible_captured|review-eligible-captured",
  "payments|Refund|rfd_seed_offer_failed|accepted-offer-failed",
  "payments|Refund|rfd_seed_offer_issued|accepted-offer-issued",
  "platform-operations|Platform Feedback|pfb_seed_checkout|checkout",
  "platform-operations|Platform Feedback|pfb_seed_inventory|inventory",
  "platform-operations|Platform Feedback|pfb_seed_listing|listing",
  "platform-operations|Platform Feedback|pfb_seed_offer|offer",
  "platform-operations|Support Request|sup_seed_active_product_not_received|active-product-not-received",
  "platform-operations|Support Request|sup_seed_resolved_partial_refund|resolved-partial-refund",
  "platform-operations|Support Request|sup_seed_self_service_product_damaged|self-service-product-damaged",
  "settlement|Payout|pyo_seed_completed|bank_seed_completed",
  "settlement|Payout|pyo_seed_failed|bank_seed_failed",
  "settlement|Wallet Ledger Entry|led_seed_available_adjustment_credit|available-adjustment-credit",
  "settlement|Wallet Ledger Entry|led_seed_payout_debit_completed|payout-debit-completed",
  "settlement|Wallet Ledger Entry|led_seed_payout_debit_failed|payout-debit-failed",
  "settlement|Wallet Ledger Entry|led_seed_payout_reversal_failed|payout-reversal-failed",
  "settlement|Wallet Ledger Entry|led_seed_pending_sale_credit|pending-sale-credit",
];

type CollectedSeedReport = Readonly<{
  contextName: string;
  streamPrefix: string;
  report: BcSeedAggregateStateReport;
}>;

function seedIdentityKey(report: BcSeedAggregateStateReport): string {
  return `${report.contextName}|${report.aggregateName}|${report.id}|${report.key}`;
}

/**
 * Report families a context commits outside its own manifest `streamPrefix`.
 * Platform Operations authors Support Request aggregates on
 * `support.support-request-*` while its manifest prefix is
 * `platform-operations.`, so the manifest prefix is blind to that family — the
 * same shape as Public Presence committing policy documents to
 * `platform-policy.document-`. Each entry is exact (context plus aggregate
 * name), names the full literal prefix it permits, is asserted to be exercised
 * rather than stale, and every report that takes it is named in the derivation
 * artifact. A report pointing at any other stream still fails.
 */
const seedReportStreamPrefixExceptions = new Map<string, string>([
  ["platform-operations|Support Request", "support.support-request-"],
]);

function reportStreamPrefixKey(entry: CollectedSeedReport): string {
  return `${entry.contextName}|${entry.report.aggregateName}`;
}

function allowedReportStreamPrefix(entry: CollectedSeedReport): string {
  return seedReportStreamPrefixExceptions.get(reportStreamPrefixKey(entry)) ?? entry.streamPrefix;
}

/**
 * Ownership binding: every report names the context it was collected from and a
 * stream that context's module actually owns. Nothing here trusts the report.
 */
function mountBindingViolations(entries: readonly CollectedSeedReport[]): readonly string[] {
  const violations: string[] = [];
  for (const entry of entries) {
    const { contextName, report } = entry;
    if (report.contextName !== contextName) {
      violations.push(`${contextName} '${report.key}' reports contextName '${report.contextName}'`);
    }
    const allowedPrefix = allowedReportStreamPrefix(entry);
    if (!report.streamId.startsWith(allowedPrefix)) {
      violations.push(
        `${contextName} '${report.key}' stream '${report.streamId}' is outside prefix '${allowedPrefix}'`,
      );
    }
  }
  return violations;
}

/** Event-store binding: the reported count is the stream's real row count. */
function eventCountBindingViolations(
  entries: readonly CollectedSeedReport[],
  actualStreamEventCounts: ReadonlyMap<string, number>,
): readonly string[] {
  const violations: string[] = [];
  for (const { contextName, report } of entries) {
    const actual = actualStreamEventCounts.get(`${contextName}|${report.streamId}`);
    if (actual === undefined) {
      violations.push(`${contextName} '${report.key}' stream '${report.streamId}' was never counted`);
      continue;
    }
    if (report.eventCount !== actual) {
      violations.push(
        `${contextName} '${report.key}' reports ${report.eventCount} events but '${report.streamId}' holds ${actual}`,
      );
    }
  }
  return violations;
}

function corpusViolations(entries: readonly CollectedSeedReport[]): readonly string[] {
  const derived = entries.map((entry) => seedIdentityKey(entry.report)).sort();
  const expected = [...frozenSeedIdentityCorpus].sort();
  const violations: string[] = [];
  if (derived.length !== expected.length) {
    violations.push(`corpus cardinality ${derived.length} does not equal the pinned ${expected.length}`);
  }
  const expectedSet = new Set(expected);
  const derivedSet = new Set(derived);
  for (const identity of derived) {
    if (!expectedSet.has(identity)) violations.push(`unpinned seed identity '${identity}'`);
  }
  for (const identity of expected) {
    if (!derivedSet.has(identity)) violations.push(`missing pinned seed identity '${identity}'`);
  }
  return violations;
}

/**
 * Ordering identifies a seeded offer-acceptance order by its source identity,
 * not by the reserved id: `seedAcceptedOfferOrder` declines to author the
 * reserved stream once `listOrderStreamsForSource` finds the generated twin the
 * offer-acceptance reaction already committed. Both id sets are inlined the way
 * this file already inlines `requiredDraftListingId`, and each is asserted
 * against Ordering's own reported seed inventory below so a rename fails loudly.
 */
const orderingOfferAcceptanceSourceReferenceIds = [
  "off_seed_twilight_masquerade_etb",
  "off_seed_twilight_masquerade_etb_encore",
] as const;
const orderingReservedOfferAcceptanceOrderIds = ["ord_seed_offer_ready", "ord_seed_review_eligible"] as const;

async function orderStreamsForOfferSource(sourceReferenceId: string): Promise<readonly string[]> {
  const result = await pools.ordering.query<Readonly<{ order_id: string }>>(
    `SELECT payload->>'orderId' AS order_id
       FROM event_store_events
      WHERE event_type = 'ordering.order.created'
        AND payload->>'sourceType' = 'offer-acceptance'
        AND payload->>'sourceReferenceId' = $1
      ORDER BY 1 ASC`,
    [sourceReferenceId],
  );
  return result.rows.map((row) => row.order_id);
}

async function orderStreamEventTypes(orderId: string): Promise<readonly string[]> {
  const result = await pools.ordering.query<Readonly<{ event_type: string }>>(
    "SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC",
    [`ordering.order-${orderId}`],
  );
  return result.rows.map((row) => row.event_type);
}

/**
 * Public Presence's seed-owned output. `seedPublicPresencePromoBarMessages`
 * rewrites `updated_at` with `now()` on every pass through its
 * `ON CONFLICT DO UPDATE`, so that column — and only that column — is excluded
 * from the freeze; `created_at` is written once on insert and is frozen.
 */
type PromoBarSemanticRow = Readonly<{
  id: string;
  title: string;
  description: string | null;
  href: string | null;
  link_label: string | null;
  tone: string;
  is_active: boolean;
  display_order: number;
  created_at: string;
}>;
type PromoBarRow = PromoBarSemanticRow & Readonly<{ updated_at: string }>;
type PolicyDocumentSemanticRow = Readonly<{
  document_id: string;
  context_name: string;
  status: string;
  value: unknown;
  effective_from: string;
  effective_until: string | null;
  created_at: string;
}>;
type PolicyDocumentStream = Readonly<{ stream_id: string; event_count: number }>;
type PublicPresenceSeedOutput = Readonly<{
  promoRows: readonly PromoBarRow[];
  promoSemantic: readonly PromoBarSemanticRow[];
  policyRow: PolicyDocumentSemanticRow;
  policyStreams: readonly PolicyDocumentStream[];
  activePolicyCount: number;
}>;

const publicPresenceSeedPromoIds = ["pbm_seed_beta_listing_fees", "pbm_seed_shipping_credit"] as const;
const publicPresenceBetaWavePolicyKey = "public-presence.beta-waves";
const policyDocumentStreamPrefix = "platform-policy.document-";

function promoSemanticColumns(row: PromoBarRow): PromoBarSemanticRow {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    href: row.href,
    link_label: row.link_label,
    tone: row.tone,
    is_active: row.is_active,
    display_order: row.display_order,
    created_at: row.created_at,
  };
}

function promoFrozenMismatches(
  expected: readonly PromoBarSemanticRow[],
  actual: readonly PromoBarRow[],
): readonly string[] {
  const violations: string[] = [];
  if (actual.length !== expected.length) {
    violations.push(`promo row count ${actual.length} does not equal the frozen ${expected.length}`);
  }
  const actualById = new Map(actual.map((row) => [row.id, promoSemanticColumns(row)]));
  for (const frozen of expected) {
    const observed = actualById.get(frozen.id);
    if (!observed) {
      violations.push(`promo row '${frozen.id}' is absent`);
      continue;
    }
    for (const column of Object.keys(frozen) as (keyof PromoBarSemanticRow)[]) {
      if (observed[column] !== frozen[column]) {
        violations.push(
          `promo '${frozen.id}'.${column}: frozen ${JSON.stringify(frozen[column])}, observed ${JSON.stringify(observed[column])}`,
        );
      }
    }
  }
  return violations;
}

/**
 * The predecessor comparison this freeze replaces: `id` and `display_order`
 * only. It is executed against the same mutated rows to prove the freeze is
 * load-bearing rather than reaching the same verdict through another clause.
 */
function promoIdAndOrderMismatches(
  expected: readonly PromoBarSemanticRow[],
  actual: readonly PromoBarRow[],
): readonly string[] {
  const violations: string[] = [];
  const actualById = new Map(actual.map((row) => [row.id, row]));
  for (const frozen of expected) {
    const observed = actualById.get(frozen.id);
    if (!observed) {
      violations.push(`promo row '${frozen.id}' is absent`);
      continue;
    }
    if (observed.display_order !== frozen.display_order) {
      violations.push(
        `promo '${frozen.id}'.display_order: frozen ${frozen.display_order}, observed ${observed.display_order}`,
      );
    }
  }
  return violations;
}

async function publicPresencePromoRows(): Promise<readonly PromoBarRow[]> {
  const result = await pools["public-presence"].query<PromoBarRow>(
    `SELECT id, title, description, href, link_label, tone, is_active, display_order,
            created_at::text AS created_at, updated_at::text AS updated_at
       FROM public_presence_promo_bar_messages
      WHERE id = ANY($1::text[])
      ORDER BY id ASC`,
    [[...publicPresenceSeedPromoIds]],
  );
  return result.rows;
}

async function publicPresenceBetaWavePolicyRow(): Promise<PolicyDocumentSemanticRow | undefined> {
  const result = await pools["public-presence"].query<PolicyDocumentSemanticRow>(
    `SELECT document_id, context_name, status, value,
            effective_from::text AS effective_from,
            effective_until::text AS effective_until,
            created_at::text AS created_at
       FROM platform_policy_documents
      WHERE policy_key = $1
      ORDER BY document_id ASC`,
    [publicPresenceBetaWavePolicyKey],
  );
  return result.rows.length === 1 ? result.rows[0] : undefined;
}

/**
 * The authoritative duplicate-authoring check for Public Presence. Its policy
 * seed commits to `platform-policy.document-<documentId>`, a stream the
 * `public-presence.` prefix invariant cannot see, so `0 -> 0` on that prefix is
 * honest but blind on its own.
 */
async function publicPresencePolicyDocumentStreams(): Promise<readonly PolicyDocumentStream[]> {
  const result = await pools["public-presence"].query<Readonly<{ stream_id: string; event_count: string }>>(
    `SELECT stream_id, COUNT(*)::text AS event_count
       FROM event_store_events
      WHERE stream_id LIKE $1
      GROUP BY stream_id
      ORDER BY stream_id ASC`,
    [`${policyDocumentStreamPrefix}%`],
  );
  return result.rows.map((row) => ({ stream_id: row.stream_id, event_count: Number(row.event_count) }));
}

async function publicPresenceActivePolicyCount(): Promise<number> {
  const result = await pools["public-presence"].query<Readonly<{ count: string }>>(
    "SELECT COUNT(*) AS count FROM platform_policy_documents WHERE status = 'active'",
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function capturePublicPresenceSeedOutput(): Promise<PublicPresenceSeedOutput> {
  const promoRows = await publicPresencePromoRows();
  const policyRow = await publicPresenceBetaWavePolicyRow();
  if (!policyRow) {
    throw new Error(`Public Presence seed did not author exactly one '${publicPresenceBetaWavePolicyKey}' policy row.`);
  }
  return {
    promoRows,
    promoSemantic: promoRows.map(promoSemanticColumns),
    policyRow,
    policyStreams: await publicPresencePolicyDocumentStreams(),
    activePolicyCount: await publicPresenceActivePolicyCount(),
  };
}

type RetainedStatePhaseOneReceipt = Readonly<{
  eligiblePrefixCounts: Readonly<Record<string, number>>;
  eligibleContexts: readonly EligibleSeedContext[];
  publicPresence: PublicPresenceSeedOutput;
  bootOneSeconds: number;
  repeatSeconds: Readonly<Record<string, number>>;
}>;

/**
 * The one retained-state seam in this partition. Phase one arms it; the harness
 * consumes it exactly once, for exactly the named phase-two case; every other
 * case in this file and in the other five partition files keeps its per-case
 * `resetMultiContextTestSchemas`.
 */
const RETAINED_STATE_PHASE_TWO_CASE =
  "retained-state phase two: proves ordinary boot two appends nothing on the retained phase-one database";
const retainedStatePhaseHandoff =
  createPlatformApiRetainedStateHandoff<RetainedStatePhaseOneReceipt>(RETAINED_STATE_PHASE_TWO_CASE);

/**
 * Derives active / source-only / omitted membership for one host runtime
 * profile straight from the generated registry manifests, using the same
 * `apiDeployables` + `apiRuntimeProfiles` and `sourceRuntimeDeployables` +
 * `sourceRuntimeProfiles` predicate the runtime mounts with. `undefined`
 * matches every declared profile, which is why it is expressible here and not
 * through `createPlatformApiHost` (that helper defaults `undefined` to
 * `public`). The derivation is cross-checked against the executable mount
 * roles for every profile a host can actually be constructed for.
 */
function deriveProfileUniverse(runtimeProfile: PlatformApiRuntimeProfile | undefined): ProfileUniverse {
  const entries = getApiHostEntries(apiContextRegistry, HOST_NAME, runtimeProfile);
  const mounted = new Set(entries.map((entry) => entry.contextName));
  const active: string[] = [];
  const sourceOnly: string[] = [];

  for (const entry of entries) {
    const manifest = entry.manifest as ApiContextManifest;
    const isActive =
      Boolean(manifest.apiDeployables?.includes(HOST_NAME)) &&
      (!runtimeProfile || Boolean(manifest.apiRuntimeProfiles?.includes(runtimeProfile)));
    (isActive ? active : sourceOnly).push(entry.contextName);
  }

  return {
    active: [...active].sort(),
    sourceOnly: [...sourceOnly].sort(),
    omitted: registryContextNames.filter((contextName) => !mounted.has(contextName)).sort(),
  };
}

/** The mount roles the runtime actually resolves when a host is constructed. */
function executableProfileUniverse(runtimeProfile: PlatformApiRuntimeProfile): ProfileUniverse {
  const runtime = createHost(runtimeProfile);
  const roleOf = (role: MountRole) =>
    runtime.mountedContexts
      .filter((entry) => entry.mountRole === role)
      .map((entry) => entry.contextName)
      .sort();
  const mounted = new Set(runtime.mountedContexts.map((entry) => entry.contextName));

  return {
    active: roleOf("active"),
    sourceOnly: roleOf("source-only"),
    omitted: registryContextNames.filter((contextName) => !mounted.has(contextName)).sort(),
  };
}

function formatUniverse(label: string, universe: ProfileUniverse): string {
  return (
    `[#6396 universe] ${label}: active(${universe.active.length})=${universe.active.join(",") || "-"} | ` +
    `source-only(${universe.sourceOnly.length})=${universe.sourceOnly.join(",") || "-"} | ` +
    `omitted(${universe.omitted.length})=${universe.omitted.join(",") || "-"}`
  );
}

type EligibleSeedContext = Readonly<{
  contextName: string;
  streamPrefix: string;
  inspects: boolean;
}>;

/**
 * The scenario-seed eligible contexts for the mounted runtime, decided by the
 * runtime's own `module.seed` + `seedProfilesOverlap` predicate. An undefined
 * module `seedProfiles` defaults to `["scenario-seed"]`, which is why this
 * cannot be shortened to "every mounted context".
 */
function eligibleScenarioSeedContexts(runtime: ApiHostRuntime): readonly EligibleSeedContext[] {
  return runtime.mountedContexts
    .filter((entry) => Boolean(entry.module.seed) && seedProfilesOverlap(entry.module.seedProfiles, seedOptions))
    .map((entry) => ({
      contextName: entry.contextName,
      streamPrefix: entry.module.streamPrefix,
      inspects: Boolean(entry.module.inspectSeedState),
    }));
}

/**
 * The only per-context append authority this slice recognises:
 * `countEventsWithPrefix(pool, module.streamPrefix)`. Counting every row in
 * `event_store_events` would fold in streams the module does not own.
 */
async function eligiblePrefixCounts(runtime: ApiHostRuntime): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const context of eligibleScenarioSeedContexts(runtime)) {
    counts[context.contextName] = await countEventsWithPrefix(poolFor(context.contextName), context.streamPrefix);
  }
  return counts;
}

/**
 * Relation count per active context database. The harness reset drops every
 * object the test user owns, so a clean case entry is zero relations
 * everywhere — including `event_store_events`, which only the boot creates.
 */
async function activeContextRelationCounts(): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const contextName of platformApiContextNames) {
    const result = await poolFor(contextName).query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );
    counts[contextName] = Number(result.rows[0]?.count ?? 0);
  }
  return counts;
}

/**
 * Re-invokes every eligible module seed in host seed order. This is the caller
 * shape `platform-runtime/api.ts` uses at its three full-drain sites within a
 * single boot: `seed:<context>`, `projection-drain:<context>` (which seeds
 * again between drains), and `seed-reconcile:<context>`.
 */
async function repeatSameBootSeedLifecyclePoint(runtime: ApiHostRuntime): Promise<void> {
  for (const contextName of getApiHostSeedOrder(apiContextRegistry, HOST_NAME, undefined, seedOptions)) {
    const context = runtime.mountedContexts.find((entry) => entry.contextName === contextName);
    if (!context?.module.seed || !seedProfilesOverlap(context.module.seedProfiles, seedOptions)) {
      continue;
    }
    await context.module.seed(context.pool, context.services, seedOptions);
  }
}

const settlementPayoutCheckpointKey = createCheckpointKey({
  projectionName: SETTLEMENT_PAYOUT_PROJECTION_NAME,
  sourceContextName: "settlement",
  subscriptionVersion: 1,
});
/**
 * Mirrors of `settlementReservedSeedIds` (`bounded-contexts/settlement/support/
 * seed-support/ids.ts`) and `paymentsReservedSeedIds.payments
 * .acceptedOfferCaptured` (`bounded-contexts/payments/support/seed-support/
 * ids.ts`). Neither context re-exports them through a public entrypoint a
 * deployable may import, and `check-structure` rejects a `seed-support/*`
 * import from `deployables/`. Every one of these is asserted present against
 * the real seeded state below, so a rename fails this file loudly rather than
 * silently skipping an arm.
 */
const settlementSeedCompletedPayoutId = "pyo_seed_completed";
const settlementSeedFailedPayoutId = "pyo_seed_failed";
const settlementSeedPendingSaleCreditId = "led_seed_pending_sale_credit";
const seededPayoutIds = [settlementSeedCompletedPayoutId, settlementSeedFailedPayoutId] as const;
const settlementSeedPrerequisitePaymentId = "pay_seed_offer_captured";
const settlementSeedSellerAccountId = identitySeedIds.demo.accountId;

/**
 * Clones the executable `landing` runtime, removing only the
 * `projectionHandlerSet` whose `projectionName` is
 * `settlement-payout-projection`. Every other handler set, service, pool, and
 * mount role is the identical object the host resolved. Under `landing`
 * Settlement is source-only, so `resolveModuleSubscriptions` skips it entirely
 * and this local handler set is the sole writer of `settlement_payout_pages`.
 */
function withLaggingSettlementPayoutProjection(runtime: ApiHostRuntime): ApiHostRuntime {
  return {
    ...runtime,
    mountedContexts: runtime.mountedContexts.map((entry) =>
      entry.contextName === "settlement"
        ? {
            ...entry,
            projectionHandlerSets: entry.projectionHandlerSets.filter(
              (set: BcProjectionHandlerSet) => set.projectionName !== SETTLEMENT_PAYOUT_PROJECTION_NAME,
            ),
          }
        : entry,
    ),
  };
}

async function settlementPayoutPageIds(): Promise<readonly string[]> {
  const result = await pools.settlement.query<Readonly<{ payout_id: string }>>(
    "SELECT payout_id FROM settlement_payout_pages ORDER BY payout_id ASC",
  );
  return result.rows.map((row) => row.payout_id);
}

type SettlementPrerequisiteRow = Readonly<{
  payment_id: string;
  amount: string;
  currency_code: string;
  status: string;
  captured_at: string | null;
}>;

async function settlementPaymentSourceRows(): Promise<readonly SettlementPrerequisiteRow[]> {
  const result = await pools.settlement.query<SettlementPrerequisiteRow>(
    `SELECT payment_id, amount::text AS amount, currency_code, status, captured_at::text AS captured_at
       FROM settlement_payment_sources
      ORDER BY payment_id ASC`,
  );
  return result.rows;
}

/**
 * Rolls one ledger entry's release event off a shared wallet stream, leaving
 * that entry posted-but-not-available while every other aggregate on the stream
 * keeps its exact event content and relative order.
 *
 * The release event sits in the middle of a stream several ledger entries share,
 * so deleting it alone would leave a version gap, and
 * `readCompleteStream` in `contracts/event-core/complete-stream.ts` rejects any
 * non-contiguous page — the rehydration would fail on the fixture instead of on
 * the behaviour under test. The remaining versions are therefore closed up, in
 * two disjoint passes so the `event_store_events_stream_version_uk` unique
 * constraint is never transiently violated, and `event_store_streams
 * .current_version` is re-derived so the next append continues the stream rather
 * than reopening the gap. Contiguity is asserted afterwards, so a fixture that
 * silently stops reproducing the intended state fails closed.
 */
async function rollWalletReleaseEventOffTheStream(
  walletStreamId: string,
  ledgerEntryId: string,
  releasedVersion: number,
): Promise<void> {
  const shiftOffset = 1_000_000;
  await pools.settlement.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id = $1", [walletStreamId]);
  const deleted = await pools.settlement.query(
    `DELETE FROM event_store_events
      WHERE stream_id = $1
        AND event_type = 'settlement.wallet.ledger-entry-available-recorded'
        AND payload->>'ledgerEntryId' = $2`,
    [walletStreamId, ledgerEntryId],
  );
  expect(deleted.rowCount, `exactly one release event for '${ledgerEntryId}' must be rolled off`).toBe(1);

  await pools.settlement.query(
    `UPDATE event_store_events
        SET stream_version = stream_version + $3
      WHERE stream_id = $1
        AND stream_version > $2`,
    [walletStreamId, releasedVersion, shiftOffset],
  );
  await pools.settlement.query(
    `UPDATE event_store_events
        SET stream_version = stream_version - $2
      WHERE stream_id = $1
        AND stream_version > $3`,
    [walletStreamId, shiftOffset + 1, shiftOffset],
  );
  await pools.settlement.query(
    `UPDATE event_store_streams
        SET current_version = COALESCE(
              (SELECT MAX(stream_version) FROM event_store_events WHERE stream_id = $1),
              0
            ),
            updated_at = now()
      WHERE stream_id = $1`,
    [walletStreamId],
  );

  const versions = await pools.settlement.query<Readonly<{ stream_version: string }>>(
    "SELECT stream_version FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC",
    [walletStreamId],
  );
  const observed = versions.rows.map((row) => Number(row.stream_version));
  expect(observed, `'${walletStreamId}' must stay contiguous from 1 after the release event is rolled off`).toEqual(
    observed.map((_value, index) => index + 1),
  );
  const stream = await pools.settlement.query<Readonly<{ current_version: string }>>(
    "SELECT current_version FROM event_store_streams WHERE stream_id = $1",
    [walletStreamId],
  );
  expect(Number(stream.rows[0]?.current_version), "the stream head must match its last event").toBe(observed.length);
  console.log(
    `[#6490 settlement draft fixture] rolled '${ledgerEntryId}' release off '${walletStreamId}' at version ` +
      `${releasedVersion}; ${observed.length} contiguous events remain`,
  );
}

/**
 * The current, shipped decision: which seeded payouts remain to author, read
 * from the authoritative `settlement.payout-*` streams.
 */
async function payoutsMissingFromStreams(): Promise<readonly string[]> {
  const result = await pools.settlement.query<Readonly<{ stream_id: string }>>(
    "SELECT DISTINCT stream_id FROM event_store_events WHERE stream_id = ANY($1::text[])",
    [seededPayoutIds.map((payoutId) => `settlement.payout-${payoutId}`)],
  );
  const present = new Set(result.rows.map((row) => row.stream_id));
  return seededPayoutIds.filter((payoutId) => !present.has(`settlement.payout-${payoutId}`));
}

/**
 * Reset-equivalent predecessor of that decision: identical in shape and asked
 * of the identical fixture, but sourced from the `settlement_payout_pages`
 * read model instead of the stream — the empty-projection decision #6396
 * exists to keep out. It raises `PREDECESSOR_WOULD_REAUTHOR_SETTLEMENT`
 * instead of appending, so the control cannot corrupt the fixture the
 * current-code assertions share.
 */
async function predecessorEmptyProjectionSeedDecision(): Promise<readonly string[]> {
  const result = await pools.settlement.query<Readonly<{ payout_id: string }>>(
    "SELECT payout_id FROM settlement_payout_pages WHERE payout_id = ANY($1::text[])",
    [[...seededPayoutIds]],
  );
  const present = new Set(result.rows.map((row) => row.payout_id));
  const wouldReauthor = seededPayoutIds.filter((payoutId) => !present.has(payoutId));
  if (wouldReauthor.length > 0) {
    throw new Error(
      `${PREDECESSOR_REAUTHOR_ERROR}: the empty-projection decision would re-issue RequestPayout for ` +
        `${wouldReauthor.join(", ")} while their settlement.payout-* streams are current.`,
    );
  }
  return wouldReauthor;
}

const requiredDraftListingId = "lst_seed_lugia_neo_genesis_draft";
const resolvedSeedSupportRequestId = "sup_seed_resolved_partial_refund";
const resolvedSeedBuyerAttestationId = "sev_seed_resolved_buyer_attestation";
const resolvedSeedPhotoId = "sev_seed_resolved_photo";

let pools: PlatformApiTestPools;
createPlatformApiBootstrapTestHarness(
  "platform_api_authoritative_seed_resume",
  (state) => {
    pools = state.pools;
  },
  { retainedStateHandoff: retainedStatePhaseHandoff },
);

/**
 * Zero-relation case-entry receipt. The harness reset is total — `DROP OWNED BY
 * CURRENT_USER CASCADE` leaves each context database with no relations at all,
 * `event_store_events` included — so a case that resets enters at zero
 * everywhere. Every case in this file except the named retained-state phase two
 * asserts this, which is what proves the opt-in handoff did not leak.
 */
async function expectZeroRelationCaseEntry(caseLabel: string): Promise<void> {
  expect(platformApiContextNames).toHaveLength(19);
  const relations = await activeContextRelationCounts();
  expect(relations, `case entry for '${caseLabel}': ${JSON.stringify(relations)}`).toEqual(
    Object.fromEntries(platformApiContextNames.map((contextName) => [contextName, 0])),
  );
  console.log(
    `[#6490 case-entry] '${caseLabel}': 0 relations in all ${platformApiContextNames.length} active context databases`,
  );
}

type SeedingModule = Pick<BcApiModule<unknown, unknown, unknown>, "contextName" | "seed" | "inspectSeedState">;
type SeedLifecycleSupportRequests = Readonly<{
  commandHandler: (
    input: Readonly<{
      streamId: string;
      command: Readonly<Record<string, unknown>>;
      context: EventStoreContext;
    }>,
  ) => Promise<unknown>;
  sweepSupportRequestDeadlines: (
    params: Readonly<{ now?: string; limit?: number }>,
    context: EventStoreContext,
  ) => Promise<Readonly<{ autoClosed: number }>>;
}>;
type SupportSeedOrderSource = Readonly<{
  order_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  total_amount: string;
}>;

/**
 * `public`, `proof`, and the `undefined` profile resolve to the identical
 * 19-active / zero-source-only universe (proved by the derivation case), so a
 * `public` host is the executable stand-in for the `undefined` scenario-seed
 * universe. `landing` is passed explicitly where the source-only path matters.
 */
function createHost(runtimeProfile: PlatformApiRuntimeProfile = "public") {
  return createPlatformApiHost({
    runtimeProfile,
    pools,
    hostPorts: {
      processorGateway: createFakePaymentProcessorGateway(),
      listingPhotoStorage,
    },
  });
}

const seedOptions: BcSeedOptions = {
  enabledDataProfiles: ["critical-bootstrap", "catalog-integration-bootstrap", "scenario-seed"],
  environmentName: "test",
};

async function ordinaryBoot(runtime: ReturnType<typeof createHost>): Promise<void> {
  await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, seedOptions);
}

/**
 * Re-invokes every mounted context's `seed` in host seed order, which is the
 * caller shape `platform-runtime/api.ts` uses at `:468` (seed), `:475`
 * (`projection-drain:<context>`), and `:494` (`seed-reconcile:<context>`)
 * within a single boot.
 */
async function invokeConvertedSeeds(runtime: ReturnType<typeof createHost>): Promise<void> {
  for (const entry of unloggedGuardProjectionFixture) {
    const context = runtime.mountedContexts.find((mounted) => mounted.contextName === entry.contextName);
    if (!context?.module.seed) {
      throw new Error(`Context '${entry.contextName}' is not mounted with a seed.`);
    }
    await context.module.seed(context.pool, context.services, seedOptions);
  }
}

function seedingModules(runtime: ReturnType<typeof createHost>): readonly SeedingModule[] {
  return runtime.mountedModules.map((entry) => entry.module as SeedingModule).filter((module) => Boolean(module.seed));
}

function poolFor(contextName: string) {
  return pools[contextName as PlatformApiContextName];
}

function requirePlatformOperationsContext(runtime: ReturnType<typeof createHost>) {
  const context = runtime.mountedContexts.find((mounted) => mounted.contextName === "platform-operations");
  if (!context?.module.seed || !context.module.inspectSeedState) {
    throw new Error("Platform Operations is not mounted with seed reconciliation and inspection.");
  }
  return context;
}

function supportRequestServices(context: ReturnType<typeof requirePlatformOperationsContext>) {
  return (context.services as unknown as Readonly<{ supportRequests: SeedLifecycleSupportRequests }>).supportRequests;
}

const seedActorContext = {
  tenantId: "tnt_seed_development",
  audit: {
    performedByUserId: "usr_test_issue_6167",
    forAccountId: "acc_test_issue_6167",
  },
} as EventStoreContext;

async function contextEventCount(contextName: string): Promise<number> {
  const result = await poolFor(contextName).query<Readonly<{ count: string }>>(
    "SELECT COUNT(*) AS count FROM event_store_events",
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function allContextEventCounts(): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const entry of unloggedGuardProjectionFixture) {
    counts[entry.contextName] = await contextEventCount(entry.contextName);
  }
  return counts;
}

async function paymentStreamEventCounts(paymentIds: readonly string[]): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const paymentId of paymentIds) {
    const streamId = `payments.payment-${paymentId}`;
    const result = await pools.payments.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id = $1",
      [streamId],
    );
    counts[paymentId] = Number(result.rows[0]?.count ?? 0);
  }
  return counts;
}

async function paymentStreamEventTypes(paymentId: string): Promise<readonly string[]> {
  const result = await pools.payments.query<Readonly<{ event_type: string }>>(
    "SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC",
    [`payments.payment-${paymentId}`],
  );
  return result.rows.map((row) => row.event_type);
}

async function supportRequestStreamEventTypes(supportRequestId: string): Promise<readonly string[]> {
  const result = await pools["platform-operations"].query<Readonly<{ event_type: string }>>(
    "SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC",
    [`support.support-request-${supportRequestId}`],
  );
  return result.rows.map((row) => row.event_type);
}

async function replaceResolvedSeedRequestWithCancelled(supportRequests: SeedLifecycleSupportRequests): Promise<void> {
  const supportRequestId = resolvedSeedSupportRequestId;
  const streamId = `support.support-request-${supportRequestId}`;
  const platformOperationsPool = pools["platform-operations"];
  const orderResult = await platformOperationsPool.query<SupportSeedOrderSource>(
    `SELECT source.order_id,
            source.buyer_account_id,
            source.seller_account_id,
            source.total_amount::text AS total_amount
     FROM support_request_pages AS request
     JOIN support_order_sources AS source ON source.order_id = request.order_id
     WHERE request.support_request_id = $1`,
    [supportRequestId],
  );
  const order = orderResult.rows[0];
  if (!order) {
    throw new Error("Platform Operations support seed order source is absent.");
  }

  await platformOperationsPool.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id = $1", [streamId]);
  await platformOperationsPool.query("DELETE FROM event_store_events WHERE stream_id = $1", [streamId]);
  await platformOperationsPool.query(
    "UPDATE event_store_streams SET current_version = 0, updated_at = now() WHERE stream_id = $1",
    [streamId],
  );
  await platformOperationsPool.query("DELETE FROM support_request_pages WHERE support_request_id = $1", [
    supportRequestId,
  ]);

  await supportRequests.commandHandler({
    streamId,
    command: {
      type: "OpenSupportRequest",
      supportRequestId,
      orderId: order.order_id,
      orderTotalAmount: order.total_amount,
      buyerAccountId: order.buyer_account_id,
      sellerAccountId: order.seller_account_id,
      flowType: "product-damaged",
      openedByAccountId: order.buyer_account_id,
      openedByRole: "buyer",
      openedAt: "2026-03-25T10:00:00.000Z",
    },
    context: seedActorContext,
  });
  await supportRequests.commandHandler({
    streamId,
    command: {
      type: "SubmitSupportEvidence",
      evidenceId: resolvedSeedBuyerAttestationId,
      submittedByAccountId: order.buyer_account_id,
      submittedByRole: "buyer",
      evidenceType: "buyer-attestation",
      summary: "Buyer reports the item arrived with shipping damage.",
      submittedAt: "2026-03-25T10:02:00.000Z",
      attachments: [],
    },
    context: seedActorContext,
  });
  await supportRequests.commandHandler({
    streamId,
    command: {
      type: "SubmitSupportEvidence",
      evidenceId: resolvedSeedPhotoId,
      submittedByAccountId: order.buyer_account_id,
      submittedByRole: "buyer",
      evidenceType: "photo",
      summary: "Photo evidence shows the damaged corner.",
      submittedAt: "2026-03-25T10:04:00.000Z",
      attachments: ["seed://support/damaged-card-corner"],
    },
    context: seedActorContext,
  });
  await supportRequests.commandHandler({
    streamId,
    command: {
      type: "CancelSupportRequest",
      cancelledAt: "2026-03-25T10:10:00.000Z",
      reason: "Cancelled-state seed reconciliation negative control.",
    },
    context: seedActorContext,
  });
}

function summarizeStates(reports: readonly BcSeedAggregateStateReport[]): string {
  const byKind = new Map<string, number>();
  for (const report of reports) {
    byKind.set(report.kind, (byKind.get(report.kind) ?? 0) + 1);
  }
  return [...byKind.entries()].map(([kind, count]) => `${kind}=${count}`).join(" ");
}

describe("authoritative seed resume", () => {
  it("derives the exact active and source-only seed universe for every host profile", async () => {
    await expectZeroRelationCaseEntry("executable seed-universe derivation");

    const derived: Record<string, ProfileUniverse> = {};
    for (const runtimeProfile of [undefined, "landing", "proof", "public"] as const) {
      const label = runtimeProfile ?? "undefined";
      const universe = deriveProfileUniverse(runtimeProfile);
      derived[label] = universe;
      console.log(formatUniverse(label, universe));

      // Every derived context is accounted for exactly once across the three roles.
      expect([...universe.active, ...universe.sourceOnly, ...universe.omitted].sort()).toEqual(
        [...registryContextNames].sort(),
      );
      expect(universe).toEqual(frozenProfileDiagnostics[label]);
    }

    // Executable cross-check: for every profile a host can be constructed for,
    // the derivation must equal the mount roles the runtime itself resolves.
    // This is what keeps the `undefined` derivation from being a reimplementation
    // that has silently diverged from production selection.
    for (const runtimeProfile of ["landing", "proof", "public"] as const) {
      expect(executableProfileUniverse(runtimeProfile), `executable mount roles for '${runtimeProfile}'`).toEqual(
        derived[runtimeProfile],
      );
    }

    // `undefined` matches every declared profile, so it must equal the profiles
    // whose declared membership is total. This is why a `public` host is the
    // executable stand-in for the `undefined` universe in the boot cases below.
    expect(derived.undefined).toEqual(derived.proof);
    expect(derived.undefined).toEqual(derived.public);
    expect(derived.undefined!.active).toHaveLength(19);
    expect(derived.undefined!.sourceOnly).toEqual([]);

    // Omitted-context negative control: a context omitted under `landing` is
    // absent from the mounted set, absent from both roles, and absent from the
    // host the runtime actually builds — presence in the registry is not
    // presence in the universe.
    const landing = derived.landing!;
    expect(landing.omitted).toContain("payments");
    expect(landing.active).not.toContain("payments");
    expect(landing.sourceOnly).not.toContain("payments");
    const landingRuntime = createHost("landing");
    expect(landingRuntime.mountedContexts.map((entry) => entry.contextName)).not.toContain("payments");
    expect(landingRuntime.mountedContexts).toHaveLength(landing.active.length + landing.sourceOnly.length);

    // Scenario-seed eligibility is decided by `seedProfilesOverlap`, not by
    // mount membership: 19 mounted contexts, 14 eligible, 11 of them inspecting.
    const runtime = createHost();
    const eligible = eligibleScenarioSeedContexts(runtime);
    expect(eligible.map((context) => context.contextName).sort()).toEqual([...frozenEligibleScenarioSeedContexts]);
    expect(
      eligible
        .filter((context) => context.inspects)
        .map((context) => context.contextName)
        .sort(),
    ).toEqual([...frozenInspectingSeedContexts]);
    expect(
      eligible
        .filter((context) => !context.inspects)
        .map((context) => context.contextName)
        .sort(),
    ).toEqual([...frozenNonInspectingSeedContexts]);
    console.log(
      `[#6396 eligibility] mounted=${runtime.mountedContexts.length} eligible=${eligible.length} ` +
        `inspecting=${eligible.filter((context) => context.inspects).length} ` +
        `non-inspecting=${frozenNonInspectingSeedContexts.join(",")}`,
    );
  });

  it("retained-state phase one: completes the first scenario-seed boot and proves all three same-boot repeats append nothing", async () => {
    await expectZeroRelationCaseEntry("retained-state phase one");

    const runtime = createHost();
    const eligible = eligibleScenarioSeedContexts(runtime);

    const bootOneStartedAt = Date.now();
    await ordinaryBoot(runtime);
    const bootOneSeconds = (Date.now() - bootOneStartedAt) / 1000;
    const afterBootOne = await eligiblePrefixCounts(runtime);
    const publicPresenceAfterBootOne = await capturePublicPresenceSeedOutput();
    console.log(`[#6396 phase] boot-one=${bootOneSeconds.toFixed(1)}s`);
    for (const context of eligible) {
      console.log(
        `[#6396 boot-one] ${context.contextName} prefix=${context.streamPrefix} ` +
          `events=${afterBootOne[context.contextName]} inspects=${context.inspects}`,
      );
    }

    // Same-boot repetition, proven separately from process boot two: re-invoke
    // the eligible seeds at each of the three full-drain lifecycle points
    // `platform-runtime/api.ts` uses within one boot and assert the settled
    // prefix count is unchanged after each. Public Presence's seed-owned output
    // is frozen across every one of them, not just across boot two.
    const repeatSeconds: Record<string, number> = {};
    let publicPresenceLatest = publicPresenceAfterBootOne;
    for (const lifecyclePoint of ["seed", "projection-drain", "seed-reconcile"] as const) {
      const repeatStartedAt = Date.now();
      await repeatSameBootSeedLifecyclePoint(runtime);
      repeatSeconds[lifecyclePoint] = (Date.now() - repeatStartedAt) / 1000;
      const afterRepeat = await eligiblePrefixCounts(runtime);
      expect(afterRepeat, `same-boot repeat at ${lifecyclePoint}`).toEqual(afterBootOne);

      publicPresenceLatest = await capturePublicPresenceSeedOutput();
      expect(
        promoFrozenMismatches(publicPresenceAfterBootOne.promoSemantic, publicPresenceLatest.promoRows),
        `Public Presence promo semantics must be frozen across the ${lifecyclePoint} repeat`,
      ).toEqual([]);
      expect(publicPresenceLatest.policyRow, `Public Presence policy row frozen across ${lifecyclePoint}`).toEqual(
        publicPresenceAfterBootOne.policyRow,
      );
      expect(
        publicPresenceLatest.policyStreams,
        `the '${policyDocumentStreamPrefix}' stream must not grow across ${lifecyclePoint}`,
      ).toEqual(publicPresenceAfterBootOne.policyStreams);

      console.log(
        `[#6396 same-boot] ${lifecyclePoint} repeat: appended=0 across ${eligible.length} contexts ` +
          `in ${repeatSeconds[lifecyclePoint]!.toFixed(1)}s`,
      );
    }

    // The only excluded promo column is the one the seed deliberately rewrites.
    // Measuring that it really moved is what makes the exclusion authorized
    // rather than convenient.
    const movedUpdatedAt = publicPresenceLatest.promoRows.filter((row) => {
      const before = publicPresenceAfterBootOne.promoRows.find((candidate) => candidate.id === row.id);
      return before !== undefined && row.updated_at !== before.updated_at;
    });
    expect(
      movedUpdatedAt.map((row) => row.id).sort(),
      "every seed-owned promo row must have its updated_at rewritten by the repeats",
    ).toEqual([...publicPresenceSeedPromoIds].sort());

    console.log(
      `[#6490 handoff] arming '${RETAINED_STATE_PHASE_TWO_CASE}' with ${eligible.length} eligible prefix counts; ` +
        `boot-one=${bootOneSeconds.toFixed(1)}s repeats=${Object.entries(repeatSeconds)
          .map(([point, seconds]) => `${point}:${seconds.toFixed(1)}s`)
          .join(" ")}`,
    );
    retainedStatePhaseHandoff.arm({
      eligiblePrefixCounts: afterBootOne,
      eligibleContexts: eligible,
      publicPresence: publicPresenceLatest,
      bootOneSeconds,
      repeatSeconds,
    });
  }, 300_000);

  it("retained-state phase two: proves ordinary boot two appends nothing on the retained phase-one database", async (testContext) => {
    expect(testContext.task.name, "the retained handoff is bound to this exact case name").toBe(
      RETAINED_STATE_PHASE_TWO_CASE,
    );

    // Fails closed with the named handoff error when phase one did not run, or
    // when the harness reset this case's schemas instead of retaining them.
    const receipt = retainedStatePhaseHandoff.requireRetained();

    const relationsAtCaseEntry = await activeContextRelationCounts();
    const resetContexts = Object.entries(relationsAtCaseEntry)
      .filter(([, count]) => count === 0)
      .map(([contextName]) => contextName);
    expect(
      resetContexts,
      `${RETAINED_STATE_HANDOFF_ERROR}: phase two must run on the retained phase-one database, not an empty one`,
    ).toEqual([]);
    console.log(
      `[#6490 handoff] consumed; retained relations ${JSON.stringify(relationsAtCaseEntry)}; ` +
        `phase-one boot=${receipt.bootOneSeconds.toFixed(1)}s`,
    );

    const runtime = createHost();
    const eligible = eligibleScenarioSeedContexts(runtime);
    expect(
      eligible.map((context) => context.contextName).sort(),
      "the eligible universe must not move between phases",
    ).toEqual(receipt.eligibleContexts.map((context) => context.contextName).sort());

    const bootTwoStartedAt = Date.now();
    await ordinaryBoot(runtime);
    const bootTwoSeconds = (Date.now() - bootTwoStartedAt) / 1000;
    const afterBootTwo = await eligiblePrefixCounts(runtime);
    const afterBootOne = receipt.eligiblePrefixCounts;

    for (const context of eligible) {
      const before = afterBootOne[context.contextName]!;
      const after = afterBootTwo[context.contextName]!;
      console.log(
        `[#6396 delta] ${context.contextName} prefix=${context.streamPrefix} ` +
          `before=${before} after=${after} delta=${after - before} inspects=${context.inspects}`,
      );
    }
    expect(afterBootTwo, "ordinary boot two must append nothing for any eligible context").toEqual(afterBootOne);

    // Honest non-inspector arms: each is reported as what it is, and none is
    // claimed to have inspected aggregate state.
    expect(afterBootTwo["commercial-terms"], "Commercial Terms is stream-prefix-only").toBeGreaterThan(0);
    expect(afterBootTwo["commercial-terms"]! - afterBootOne["commercial-terms"]!).toBe(0);
    expect(afterBootOne.pricing, "Pricing is a declared no-op").toBe(0);
    expect(afterBootTwo.pricing).toBe(0);
    expect(afterBootOne["public-presence"], "Public Presence authors no public-presence.* stream").toBe(0);
    expect(afterBootTwo["public-presence"]).toBe(0);
    for (const contextName of frozenNonInspectingSeedContexts) {
      const context = runtime.mountedContexts.find((entry) => entry.contextName === contextName);
      expect(
        context?.module.inspectSeedState,
        `${contextName} must not claim inspected aggregate state`,
      ).toBeUndefined();
    }

    // Public Presence's real output, frozen semantically. The `public-presence.`
    // prefix staying at 0 -> 0 says nothing about the policy document the seed
    // actually commits, so that stream is counted directly.
    const publicPresenceAfterBootTwo = await capturePublicPresenceSeedOutput();
    expect(
      promoFrozenMismatches(receipt.publicPresence.promoSemantic, publicPresenceAfterBootTwo.promoRows),
      "Public Presence promo semantics must be frozen across ordinary boot two",
    ).toEqual([]);
    expect(publicPresenceAfterBootTwo.policyRow, "the exact beta-wave policy row must be frozen").toEqual(
      receipt.publicPresence.policyRow,
    );
    expect(publicPresenceAfterBootTwo.policyStreams, "exactly one seed-owned policy document stream").toHaveLength(1);
    expect(
      publicPresenceAfterBootTwo.policyStreams,
      `the '${policyDocumentStreamPrefix}' stream must be unchanged across boot two`,
    ).toEqual(receipt.publicPresence.policyStreams);
    for (const row of publicPresenceAfterBootTwo.promoRows) {
      console.log(
        `[#6490 public-presence promo] ${row.id} tone=${row.tone} active=${row.is_active} order=${row.display_order} ` +
          `created=${row.created_at} title=${JSON.stringify(row.title)}`,
      );
    }
    console.log(
      `[#6490 public-presence policy] key=${publicPresenceBetaWavePolicyKey} ` +
        `document=${publicPresenceAfterBootTwo.policyRow.document_id} status=${publicPresenceAfterBootTwo.policyRow.status} ` +
        `streams=${JSON.stringify(publicPresenceAfterBootTwo.policyStreams)} ` +
        `global-active-rows=${publicPresenceAfterBootTwo.activePolicyCount}`,
    );

    const publicPresenceMount = runtime.mountedContexts.find((entry) => entry.contextName === "public-presence");
    if (!publicPresenceMount?.module.seed) {
      throw new Error("Public Presence is not mounted with a seed.");
    }

    // Mutant one: a single promo semantic column. The frozen comparison must see
    // it while the predecessor `id` + `display_order` comparison cannot, and the
    // seed must reconcile it back.
    const mutatedPromoId = publicPresenceSeedPromoIds[0];
    await pools["public-presence"].query("UPDATE public_presence_promo_bar_messages SET tone = $2 WHERE id = $1", [
      mutatedPromoId,
      "warning",
    ]);
    const mutatedPromoRows = await publicPresencePromoRows();
    const frozenPromoViolations = promoFrozenMismatches(receipt.publicPresence.promoSemantic, mutatedPromoRows);
    expect(frozenPromoViolations.length, "the frozen promo comparison must report the mutated column").toBeGreaterThan(
      0,
    );
    expect(
      promoIdAndOrderMismatches(receipt.publicPresence.promoSemantic, mutatedPromoRows),
      "the id + display_order comparison must be blind to the same mutation",
    ).toEqual([]);
    console.log(
      `[#6490 promo mutant] frozen violations=${JSON.stringify(frozenPromoViolations)}; ` +
        "id+display_order-only violations=0",
    );

    await publicPresenceMount.module.seed(publicPresenceMount.pool, publicPresenceMount.services, seedOptions);
    expect(
      promoFrozenMismatches(receipt.publicPresence.promoSemantic, await publicPresencePromoRows()),
      "re-invoking only the Public Presence seed must reconcile the mutated column back",
    ).toEqual([]);

    // Mutant two: delete the exact policy row and insert an unrelated active
    // one. A global active-row count cannot see this; the exact-row assertion
    // must, and the re-invoked seed then authors a duplicate policy document on
    // a stream the `public-presence.` prefix invariant never counts.
    const activePolicyCountBefore = await publicPresenceActivePolicyCount();
    const policyStreamsBefore = await publicPresencePolicyDocumentStreams();
    await pools["public-presence"].query("DELETE FROM platform_policy_documents WHERE policy_key = $1", [
      publicPresenceBetaWavePolicyKey,
    ]);
    await pools["public-presence"].query(
      `INSERT INTO platform_policy_documents (
         document_id, policy_key, context_name, schema_summary, status, value,
         effective_from, effective_until, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', $5::jsonb, now(), NULL, now(), now())`,
      [
        "pol_seed_unrelated_negative_control",
        "public-presence.unrelated-negative-control",
        "public-presence",
        "{ unrelatedNegativeControl }",
        JSON.stringify({ unrelatedNegativeControl: true }),
      ],
    );
    expect(
      await publicPresenceActivePolicyCount(),
      "a global active-row count cannot see the exact policy row disappear",
    ).toBe(activePolicyCountBefore);
    expect(await publicPresenceBetaWavePolicyRow(), "the exact-row assertion must go red").toBeUndefined();

    await publicPresenceMount.module.seed(publicPresenceMount.pool, publicPresenceMount.services, seedOptions);
    const policyStreamsAfter = await publicPresencePolicyDocumentStreams();
    const recreatedPolicyRow = await publicPresenceBetaWavePolicyRow();
    const addedPolicyStreams = policyStreamsAfter.filter(
      (stream) => !policyStreamsBefore.some((before) => before.stream_id === stream.stream_id),
    );
    console.log(
      `[#6490 policy mutant] global-active-rows ${activePolicyCountBefore} -> ${await publicPresenceActivePolicyCount()} ` +
        `(unchanged by the exact-row deletion); projection row recreated=${recreatedPolicyRow?.document_id ?? "absent"}; ` +
        `'${policyDocumentStreamPrefix}' streams ${policyStreamsBefore.length} -> ${policyStreamsAfter.length}; ` +
        `appended=${JSON.stringify(addedPolicyStreams)}`,
    );
    expect(
      addedPolicyStreams.length,
      "the re-invoked seed re-authors a policy document the public-presence. prefix invariant cannot see",
    ).toBeGreaterThan(0);

    console.log(
      `[#6490 timing] phase-one boot=${receipt.bootOneSeconds.toFixed(1)}s ` +
        `repeats=${Object.values(receipt.repeatSeconds)
          .reduce((total, seconds) => total + seconds, 0)
          .toFixed(1)}s phase-two boot=${bootTwoSeconds.toFixed(1)}s eligible=${eligible.length}`,
    );
  }, 300_000);

  it("does not re-author Settlement while its payout projection lags the stream", async () => {
    await expectZeroRelationCaseEntry("Settlement projection lag");

    const runtime = createHost();
    await ordinaryBoot(runtime);

    // Fixture capture, before anything lags. The exact cross-context
    // prerequisite Settlement's seed reads, the retained stream-prefix count,
    // the payout projection checkpoint, and the projected payout rows.
    const prerequisiteRows = await settlementPaymentSourceRows();
    const prerequisite = prerequisiteRows.find((row) => row.payment_id === settlementSeedPrerequisitePaymentId);
    expect(prerequisite, "the exact Settlement seed prerequisite payment source is absent").toBeDefined();
    expect(prerequisite!.status).toBe("captured");
    const retainedSettlementEvents = await countEventsWithPrefix(pools.settlement, "settlement.");
    expect(retainedSettlementEvents).toBeGreaterThan(0);
    const checkpointBefore = await loadSubscriptionCheckpoint(pools.settlement, settlementPayoutCheckpointKey);
    expect(checkpointBefore, "the payout projection checkpoint must exist after a completed boot").not.toBeNull();
    expect(await settlementPayoutPageIds()).toEqual([...seededPayoutIds].sort());

    // Establish the lag: only `settlement_payout_pages` and its checkpoint fall
    // behind. The `settlement.*` streams stay exactly as boot one left them.
    await pools.settlement.query("DELETE FROM settlement_payout_pages");
    await pools.settlement.query("DELETE FROM event_subscription_checkpoints WHERE checkpoint_key = $1", [
      settlementPayoutCheckpointKey,
    ]);
    expect(await settlementPayoutPageIds()).toEqual([]);
    expect(await loadSubscriptionCheckpoint(pools.settlement, settlementPayoutCheckpointKey)).toBeNull();
    expect(await countEventsWithPrefix(pools.settlement, "settlement."), "the stream must stay current").toBe(
      retainedSettlementEvents,
    );
    // Retained lag state exists only where this fixture established it: the
    // other Settlement projection checkpoints are untouched.
    const otherSettlementCheckpoints = await pools.settlement.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM event_subscription_checkpoints WHERE checkpoint_key <> $1",
      [settlementPayoutCheckpointKey],
    );
    expect(Number(otherSettlementCheckpoints.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    // Clone the executable `landing` runtime, withholding only the named
    // projection handler set. Settlement is source-only under `landing`, so the
    // 445-455 seed/drain/seed/drain path is the one that runs.
    const landingRuntime = createHost("landing");
    const settlementMount = landingRuntime.mountedContexts.find((entry) => entry.contextName === "settlement");
    expect(settlementMount?.mountRole, "Settlement must be source-only under landing").toBe("source-only");
    const laggingRuntime = withLaggingSettlementPayoutProjection(landingRuntime);
    const laggingSettlement = laggingRuntime.mountedContexts.find((entry) => entry.contextName === "settlement");
    expect(settlementMount!.projectionHandlerSets.map((set) => set.projectionName)).toContain(
      SETTLEMENT_PAYOUT_PROJECTION_NAME,
    );
    expect(laggingSettlement!.projectionHandlerSets.map((set) => set.projectionName)).not.toContain(
      SETTLEMENT_PAYOUT_PROJECTION_NAME,
    );
    expect(laggingSettlement!.projectionHandlerSets).toHaveLength(settlementMount!.projectionHandlerSets.length - 1);
    // Everything except the withheld handler set is the identical object.
    for (const entry of laggingRuntime.mountedContexts) {
      const original = landingRuntime.mountedContexts.find((candidate) => candidate.contextName === entry.contextName)!;
      expect(entry.pool).toBe(original.pool);
      expect(entry.services).toBe(original.services);
      expect(entry.mountRole).toBe(original.mountRole);
      if (entry.contextName !== "settlement") {
        expect(entry).toBe(original);
      }
    }

    await seedApiHostIfEmpty(apiContextRegistry, HOST_NAME, laggingRuntime, {
      ...seedOptions,
      runtimeProfile: "landing",
    });

    // Current code decides from the stream: nothing is re-authored, and the
    // withheld projection is still visibly behind afterwards.
    const settlementEventsAfterRepeat = await countEventsWithPrefix(pools.settlement, "settlement.");
    expect(settlementEventsAfterRepeat - retainedSettlementEvents).toBe(0);
    expect(await settlementPayoutPageIds(), "the withheld projection must stay behind").toEqual([]);
    expect(await loadSubscriptionCheckpoint(pools.settlement, settlementPayoutCheckpointKey)).toBeNull();
    expect(await payoutsMissingFromStreams(), "the streams still carry both seeded payouts").toEqual([]);
    console.log(
      `[#6396 lag] settlement prefix ${retainedSettlementEvents} -> ${settlementEventsAfterRepeat} (delta 0); ` +
        `settlement_payout_pages=0 rows; checkpoint '${settlementPayoutCheckpointKey}'=absent; ` +
        `prerequisite ${prerequisite!.payment_id} status=${prerequisite!.status}`,
    );

    // Predecessor mutant on that same fixture: identical question, sourced from
    // the empty projection instead of the stream.
    await expect(predecessorEmptyProjectionSeedDecision()).rejects.toThrow(PREDECESSOR_REAUTHOR_ERROR);
    console.log(`[#6396 predecessor] empty-projection decision raised ${PREDECESSOR_REAUTHOR_ERROR}`);

    // Paired prerequisite negative: give the seed real work to do, then prove an
    // unrelated captured row cannot stand in for the exact missing target.
    const completedPayoutStreamId = `settlement.payout-${settlementSeedCompletedPayoutId}`;
    await pools.settlement.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id = $1", [
      completedPayoutStreamId,
    ]);
    await pools.settlement.query("DELETE FROM event_store_events WHERE stream_id = $1", [completedPayoutStreamId]);
    await pools.settlement.query(
      "UPDATE event_store_streams SET current_version = 0, updated_at = now() WHERE stream_id = $1",
      [completedPayoutStreamId],
    );
    expect(await payoutsMissingFromStreams()).toEqual([settlementSeedCompletedPayoutId]);
    const withWorkPending = await countEventsWithPrefix(pools.settlement, "settlement.");

    const unrelatedPaymentId = "pay_seed_unrelated_negative_control";
    await pools.settlement.query("DELETE FROM settlement_payment_sources WHERE payment_id = $1", [
      settlementSeedPrerequisitePaymentId,
    ]);
    await pools.settlement.query(
      `INSERT INTO settlement_payment_sources (
         payment_id, buyer_account_id, amount, currency_code, processor_name,
         processor_payment_reference, processor_status, status, created_at, updated_at, captured_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), now())`,
      [
        unrelatedPaymentId,
        "acc_seed_unrelated_buyer",
        prerequisite!.amount,
        prerequisite!.currency_code,
        "fake",
        "ref_unrelated_negative_control",
        "captured",
        "captured",
      ],
    );
    const negativeRows = await settlementPaymentSourceRows();
    expect(negativeRows.map((row) => row.payment_id)).toContain(unrelatedPaymentId);
    expect(negativeRows.map((row) => row.payment_id)).not.toContain(settlementSeedPrerequisitePaymentId);

    const settlementContext = runtime.mountedContexts.find((entry) => entry.contextName === "settlement")!;
    await settlementContext.module.seed!(settlementContext.pool, settlementContext.services, seedOptions);
    expect(
      await countEventsWithPrefix(pools.settlement, "settlement."),
      "an unrelated captured row must not stand in for the exact missing prerequisite",
    ).toBe(withWorkPending);
    expect(await payoutsMissingFromStreams()).toEqual([settlementSeedCompletedPayoutId]);

    // Restore the exact target and the same seed does the pending work.
    await pools.settlement.query(
      `INSERT INTO settlement_payment_sources (
         payment_id, buyer_account_id, amount, currency_code, processor_name,
         processor_payment_reference, processor_status, status, created_at, updated_at, captured_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), $9)`,
      [
        settlementSeedPrerequisitePaymentId,
        "acc_seed_demo_buyer",
        prerequisite!.amount,
        prerequisite!.currency_code,
        "fake",
        "ref_restored_exact_target",
        "captured",
        "captured",
        prerequisite!.captured_at,
      ],
    );
    await settlementContext.module.seed!(settlementContext.pool, settlementContext.services, seedOptions);
    const afterExactTarget = await countEventsWithPrefix(pools.settlement, "settlement.");
    expect(afterExactTarget, "the exact prerequisite unblocks the pending payout").toBeGreaterThan(withWorkPending);
    expect(await payoutsMissingFromStreams()).toEqual([]);
    console.log(
      `[#6396 prerequisite] unrelated-row-only appends=0 (prefix ${withWorkPending}); ` +
        `exact-target-restored appends=${afterExactTarget - withWorkPending}`,
    );
  }, 300_000);

  it("reconciles every inspecting scenario-seed context to its frozen identity corpus and active state", async () => {
    await expectZeroRelationCaseEntry("frozen identity corpus");

    const runtime = createHost();
    await ordinaryBoot(runtime);

    const inspecting = eligibleScenarioSeedContexts(runtime).filter((context) => context.inspects);
    expect(inspecting.map((context) => context.contextName).sort()).toEqual([...frozenInspectingSeedContexts]);

    // The whole table is emitted before anything is asserted, so a single
    // non-active aggregate cannot truncate the omission-revealing evidence.
    const collected: CollectedSeedReport[] = [];
    for (const context of inspecting) {
      const mount = runtime.mountedContexts.find((entry) => entry.contextName === context.contextName)!;
      const reports = await mount.module.inspectSeedState!(mount.pool, seedOptions);
      expect(reports.length, `${context.contextName} reports no seed aggregates`).toBeGreaterThan(0);
      console.log(
        `[#6396 aggregate-state] ${context.contextName}: ${reports.length} aggregates ${summarizeStates(reports)}`,
      );
      for (const report of reports) {
        console.log(
          `[#6396 aggregate-state]   ${context.contextName} ${report.aggregateName} '${report.key}' id=${report.id} ` +
            `kind=${report.kind} status=${report.status ?? "-"} events=${report.eventCount} stream=${report.streamId}`,
        );
        collected.push({ contextName: context.contextName, streamPrefix: context.streamPrefix, report });
      }
    }

    // Real per-stream row counts, read from each context's own database. This is
    // what makes `report.eventCount` checkable instead of merely non-empty.
    const actualStreamEventCounts = new Map<string, number>();
    for (const { contextName, report } of collected) {
      const cacheKey = `${contextName}|${report.streamId}`;
      if (actualStreamEventCounts.has(cacheKey)) continue;
      const result = await poolFor(contextName).query<Readonly<{ count: string }>>(
        "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id = $1",
        [report.streamId],
      );
      actualStreamEventCounts.set(cacheKey, Number(result.rows[0]?.count ?? 0));
    }

    // Derivation artifact: the corpus itself, and the inspector implementation
    // every row of it was read from.
    const derivedCorpus = collected.map((entry) => seedIdentityKey(entry.report)).sort();
    console.log(`[#6490 corpus artifact] cardinality=${derivedCorpus.length} contexts=${inspecting.length}`);
    for (const contextName of frozenInspectingSeedContexts) {
      const rows = derivedCorpus.filter((identity) => identity.startsWith(`${contextName}|`));
      console.log(
        `[#6490 corpus artifact] ${contextName} <- ${seedInspectorDerivationSources[contextName]} : ${rows.length} identities`,
      );
    }
    console.log(`[#6490 corpus artifact json] ${JSON.stringify(derivedCorpus)}`);

    // Every declared out-of-prefix family must be exercised by a real report, so
    // the exception list can never silently outlive the behaviour it describes.
    const exercisedPrefixExceptions = new Map<string, number>();
    for (const entry of collected) {
      const key = reportStreamPrefixKey(entry);
      if (!seedReportStreamPrefixExceptions.has(key)) continue;
      exercisedPrefixExceptions.set(key, (exercisedPrefixExceptions.get(key) ?? 0) + 1);
    }
    for (const [key, count] of exercisedPrefixExceptions) {
      console.log(
        `[#6490 corpus artifact] out-of-manifest-prefix family ${key} -> ` +
          `'${seedReportStreamPrefixExceptions.get(key)}' (${count} reports)`,
      );
    }
    expect(
      [...seedReportStreamPrefixExceptions.keys()].filter((key) => !exercisedPrefixExceptions.has(key)),
      "a declared out-of-manifest-prefix exception is stale",
    ).toEqual([]);

    const duplicateIdentities = derivedCorpus.filter((identity, index) => derivedCorpus.indexOf(identity) !== index);
    expect(duplicateIdentities, "an aggregate identity was reported more than once").toEqual([]);
    expect(mountBindingViolations(collected), "reports are not bound to their own mount and stream prefix").toEqual([]);
    expect(
      eventCountBindingViolations(collected, actualStreamEventCounts),
      "reported event counts do not equal the real event_store_events rows",
    ).toEqual([]);
    expect(corpusViolations(collected), "the reported identity corpus does not equal the pinned corpus").toEqual([]);

    // Executed mutants. Each varies exactly one governing input of the frozen
    // bindings above; a control that reached the same verdict through another
    // clause would not count, so each mutant asserts the *other* bindings stay
    // green.
    const droppedReport = collected.slice(1);
    expect(corpusViolations(droppedReport).length, "dropping one report must turn the corpus red").toBeGreaterThan(0);

    const relabelledContext = collected.map((entry, index) =>
      index === 0 ? { ...entry, report: { ...entry.report, contextName: "not-the-mounted-context" } } : entry,
    );
    expect(
      mountBindingViolations(relabelledContext).length,
      "relabelling one report's contextName must turn the mount binding red",
    ).toBeGreaterThan(0);
    expect(
      eventCountBindingViolations(relabelledContext, actualStreamEventCounts),
      "the relabel mutant must be caught by the mount binding, not by the event-count binding",
    ).toEqual([]);

    let repointed: CollectedSeedReport[] | undefined;
    let repointDescription = "";
    for (const entry of collected) {
      const candidate = await poolFor(entry.contextName).query<Readonly<{ stream_id: string; count: string }>>(
        `SELECT stream_id, COUNT(*)::text AS count
           FROM event_store_events
          WHERE stream_id LIKE $1
            AND stream_id <> $2
          GROUP BY stream_id
         HAVING COUNT(*) <> $3::bigint
          ORDER BY stream_id ASC
          LIMIT 1`,
        [`${allowedReportStreamPrefix(entry)}%`, entry.report.streamId, String(entry.report.eventCount)],
      );
      const target = candidate.rows[0];
      if (!target) continue;
      actualStreamEventCounts.set(`${entry.contextName}|${target.stream_id}`, Number(target.count));
      repointed = collected.map((candidateEntry) =>
        candidateEntry === entry
          ? { ...candidateEntry, report: { ...candidateEntry.report, streamId: target.stream_id } }
          : candidateEntry,
      );
      repointDescription =
        `${entry.contextName} '${entry.report.key}' ${entry.report.streamId} (${entry.report.eventCount} events) ` +
        `-> ${target.stream_id} (${target.count} events)`;
      break;
    }
    expect(repointed, "no non-empty same-prefix stream with a different event count was available").toBeDefined();
    expect(
      eventCountBindingViolations(repointed!, actualStreamEventCounts).length,
      "repointing one report's streamId must turn the event-count binding red",
    ).toBeGreaterThan(0);
    expect(
      mountBindingViolations(repointed!),
      "the repoint mutant must be caught by the event-count binding, not by the prefix binding",
    ).toEqual([]);
    console.log(
      `[#6490 corpus mutants] drop=red relabel=red repoint=red (${repointDescription}); ` +
        `pinned cardinality=${frozenSeedIdentityCorpus.length}`,
    );

    // Ordering finishes with exactly one active order per offer source identity
    // and no duplicate reserved stream. Its two reserved offer-acceptance ids
    // are intentionally absent at main and are not required here.
    const orderingReports = collected.filter((entry) => entry.contextName === "ordering").map((entry) => entry.report);
    const orderingReportIds = orderingReports.map((report) => report.id);
    const orderingReportKeys = orderingReports.map((report) => report.key);
    for (const reservedOrderId of orderingReservedOfferAcceptanceOrderIds) {
      expect(orderingReportIds, `reserved order id '${reservedOrderId}' left Ordering's seed inventory`).toContain(
        reservedOrderId,
      );
    }
    for (const sourceReferenceId of orderingOfferAcceptanceSourceReferenceIds) {
      expect(orderingReportKeys, `offer source '${sourceReferenceId}' left Ordering's seed inventory`).toContain(
        sourceReferenceId,
      );
    }

    const sourceResolvedOrderIds: string[] = [];
    for (const sourceReferenceId of orderingOfferAcceptanceSourceReferenceIds) {
      const orderIds = await orderStreamsForOfferSource(sourceReferenceId);
      expect(
        orderIds,
        `offer source '${sourceReferenceId}' must resolve to exactly one ordering.order.created stream`,
      ).toHaveLength(1);
      const orderId = orderIds[0]!;
      const eventTypes = await orderStreamEventTypes(orderId);
      // `loadSeedOrderState` rehydrates `kind: active` exactly when the stream's
      // created event set the order id, so a single `ordering.order.created`
      // first event with no cancellation is that aggregate rehydrating active.
      expect(eventTypes[0], `order '${orderId}' does not open with ordering.order.created`).toBe(
        "ordering.order.created",
      );
      expect(
        eventTypes.filter((eventType) => eventType === "ordering.order.created"),
        `order '${orderId}' carries more than one creation event`,
      ).toHaveLength(1);
      expect(eventTypes, `order '${orderId}' is cancelled, not active`).not.toContain("ordering.order.cancelled");
      sourceResolvedOrderIds.push(orderId);
      console.log(
        `[#6490 ordering source-identity] source=${sourceReferenceId} order=${orderId} ` +
          `events=${eventTypes.length} types=${eventTypes.join(">")}`,
      );
    }
    expect(new Set(sourceResolvedOrderIds).size, "two offer sources resolved to the same order").toBe(
      sourceResolvedOrderIds.length,
    );

    const duplicateReservedStreams: string[] = [];
    for (const reservedOrderId of orderingReservedOfferAcceptanceOrderIds) {
      const eventTypes = await orderStreamEventTypes(reservedOrderId);
      const isSourceResolved = sourceResolvedOrderIds.includes(reservedOrderId);
      if (eventTypes.length > 0 && !isSourceResolved) {
        duplicateReservedStreams.push(`${reservedOrderId} (${eventTypes.length} events)`);
      }
      console.log(
        `[#6490 ordering reserved] ${reservedOrderId}: ${eventTypes.length} events; source-resolved=${isSourceResolved}`,
      );
    }
    expect(
      duplicateReservedStreams,
      "a reserved offer-acceptance order stream duplicates a source-identified order",
    ).toEqual([]);

    // The ten non-Ordering inspecting contexts finish identity-matching active,
    // and every Ordering aggregate other than the two intentionally absent
    // reserved offer-acceptance ids does too.
    const intentionallyAbsent = new Set<string>(orderingReservedOfferAcceptanceOrderIds);
    const requiredActive = collected.filter(
      (entry) => entry.contextName !== "ordering" || !intentionallyAbsent.has(entry.report.id),
    );
    const notActive = requiredActive
      .filter((entry) => entry.report.kind !== "active")
      .map(
        (entry) =>
          `${entry.contextName} ${entry.report.aggregateName} '${entry.report.key}' id=${entry.report.id} ` +
          `kind=${entry.report.kind} status=${entry.report.status ?? "-"} events=${entry.report.eventCount} ` +
          `stream=${entry.report.streamId}`,
      );
    for (const entry of notActive) {
      console.log(`[#6396 aggregate-state NOT-ACTIVE] ${entry}`);
    }
    expect(notActive, `inspecting contexts finished with non-active seed aggregates:\n${notActive.join("\n")}`).toEqual(
      [],
    );
    const rehydratedNothing = requiredActive
      .filter((entry) => entry.report.eventCount <= 0)
      .map((entry) => `${entry.contextName} '${entry.report.key}' id=${entry.report.id}`);
    expect(
      rehydratedNothing,
      `seed aggregates reported without rehydrating any events:\n${rehydratedNothing.join("\n")}`,
    ).toEqual([]);

    // Marketplace business status `draft` is not aggregate kind `draft`: the
    // seeded draft listing is a complete aggregate whose business status is
    // deliberately draft.
    const marketplaceMount = runtime.mountedContexts.find((entry) => entry.contextName === "marketplace")!;
    const marketplaceReports = await marketplaceMount.module.inspectSeedState!(marketplaceMount.pool, seedOptions);
    expect(marketplaceReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: requiredDraftListingId, kind: "active", status: "draft" }),
      ]),
    );

    // A pre-existing non-active aggregate reconciles rather than failing the
    // boot. Rolling the seeded wallet's release event off the stream leaves the
    // pending sale credit posted-but-not-available, which `inspectSeedState`
    // reports as `draft`.
    const settlementMount = runtime.mountedContexts.find((entry) => entry.contextName === "settlement")!;
    const walletStreamId = `settlement.wallet-${settlementSeedSellerAccountId}`;
    const released = await pools.settlement.query<Readonly<{ stream_version: string }>>(
      `SELECT stream_version
         FROM event_store_events
        WHERE stream_id = $1
          AND event_type = 'settlement.wallet.ledger-entry-available-recorded'
          AND payload->>'ledgerEntryId' = $2`,
      [walletStreamId, settlementSeedPendingSaleCreditId],
    );
    expect(released.rows, "the seeded pending sale credit was never released").toHaveLength(1);
    const releasedVersion = Number(released.rows[0]!.stream_version);
    await rollWalletReleaseEventOffTheStream(walletStreamId, settlementSeedPendingSaleCreditId, releasedVersion);

    const draftReports = await settlementMount.module.inspectSeedState!(settlementMount.pool, seedOptions);
    expect(draftReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: settlementSeedPendingSaleCreditId,
          kind: "draft",
        }),
      ]),
    );

    await expect(
      settlementMount.module.seed!(settlementMount.pool, settlementMount.services, seedOptions),
    ).resolves.toBeUndefined();

    const reconciledReports = await settlementMount.module.inspectSeedState!(settlementMount.pool, seedOptions);
    expect(reconciledReports.filter((report) => report.kind !== "active")).toEqual([]);
    expect(reconciledReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: settlementSeedPendingSaleCreditId,
          kind: "active",
        }),
      ]),
    );
    console.log(
      `[#6396 reconcile] inspecting=${inspecting.length} all kind=active; ` +
        "settlement pending-sale-credit draft -> active without boot failure",
    );
  }, 300_000);

  it("enumerates stream-sourced seed-state coverage from the runtime mount list", async () => {
    await expectZeroRelationCaseEntry("stream-sourced coverage enumeration");

    const runtime = createHost();
    const modules = seedingModules(runtime);
    expect(modules.length).toBeGreaterThan(0);

    const missing = modules
      .filter((module) => !module.inspectSeedState && !seedStateExemptions.has(module.contextName))
      .map((module) => module.contextName);
    expect(missing, `seeding contexts without stream-sourced seed state: ${missing.join(", ")}`).toEqual([]);

    // No stale exemptions: every exempt name must still be a mounted seeding context.
    const mountedNames = new Set(modules.map((module) => module.contextName));
    const staleExemptions = [...seedStateExemptions.keys()].filter((name) => !mountedNames.has(name));
    expect(staleExemptions).toEqual([]);

    // The UNLOGGED-truncation fixture is not the coverage authority, but it may
    // never drift: every context it names must still be a mounted, non-exempt,
    // inspecting seeding context derived from the runtime mount list.
    const derivedInspecting = new Set(
      eligibleScenarioSeedContexts(runtime)
        .filter((context) => context.inspects)
        .map((context) => context.contextName),
    );
    for (const entry of unloggedGuardProjectionFixture) {
      const module = modules.find((candidate) => candidate.contextName === entry.contextName);
      expect(module, `truncation-fixture context '${entry.contextName}' is not mounted`).toBeDefined();
      expect(seedStateExemptions.has(entry.contextName)).toBe(false);
      expect(module?.inspectSeedState, `'${entry.contextName}' declares no inspectSeedState`).toBeDefined();
      expect(
        derivedInspecting.has(entry.contextName),
        `truncation-fixture context '${entry.contextName}' is not in the derived inspecting set`,
      ).toBe(true);
    }

    // Omission negative control: a mounted seeding context that does not declare
    // stream-sourced seed state must be reported by the very same enumeration.
    const withOmission = modules.map((module) =>
      module.contextName === "inventory" ? { contextName: module.contextName, seed: module.seed } : module,
    );
    const omitted = withOmission
      .filter((module) => !module.inspectSeedState && !seedStateExemptions.has(module.contextName))
      .map((module) => module.contextName);
    expect(omitted).toEqual(["inventory"]);
  });

  it("resumes every converted context after its UNLOGGED guard projections are truncated", async () => {
    await expectZeroRelationCaseEntry("UNLOGGED truncation resume");

    const runtime = createHost();
    await ordinaryBoot(runtime);

    const afterBootOne = await allContextEventCounts();
    for (const [contextName, count] of Object.entries(afterBootOne)) {
      expect(count, `${contextName} must have seeded events after boot one`).toBeGreaterThan(0);
    }
    const marketplaceModule = seedingModules(runtime).find((module) => module.contextName === "marketplace");
    const marketplaceReports = await marketplaceModule!.inspectSeedState!(poolFor("marketplace"));
    expect(marketplaceReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: requiredDraftListingId,
          kind: "active",
          status: "draft",
        }),
      ]),
    );

    for (const entry of unloggedGuardProjectionFixture) {
      await poolFor(entry.contextName).query(`TRUNCATE TABLE ${entry.projections.join(", ")} CASCADE`);
      for (const projection of entry.projections) {
        const rows = await poolFor(entry.contextName).query<Readonly<{ count: string }>>(
          `SELECT COUNT(*) AS count FROM ${projection}`,
        );
        expect(Number(rows.rows[0]?.count ?? 0), `${entry.contextName}.${projection}`).toBe(0);
      }
    }
    expect(await allContextEventCounts(), "truncating projections must not touch streams").toEqual(afterBootOne);

    // Re-invoke every seed three times against the emptied projections, exactly
    // as one boot does at api.ts:468, :475 and :494. Before this change the
    // inventory pass threw `InventoryDomainError: Storage location has already
    // been created.` and no later context seeded at all.
    for (let invocation = 1; invocation <= 3; invocation += 1) {
      await invokeConvertedSeeds(runtime);
      expect(await allContextEventCounts(), `invocation ${invocation}`).toEqual(afterBootOne);
    }

    const afterBootTwo = await allContextEventCounts();
    expect(afterBootTwo).toEqual(afterBootOne);

    for (const entry of unloggedGuardProjectionFixture) {
      const module = seedingModules(runtime).find((candidate) => candidate.contextName === entry.contextName);
      const reports = await module!.inspectSeedState!(poolFor(entry.contextName));
      console.log(
        `[#4906] ${entry.contextName}: truncated ${entry.projections.join(", ")} -> ` +
          `${reports.length} seed aggregates ${summarizeStates(reports)}, ` +
          `events ${afterBootTwo[entry.contextName]}`,
      );
      for (const report of reports) {
        console.log(
          `[#4906]   ${entry.contextName} ${report.aggregateName} '${report.key}' ` +
            `kind=${report.kind} status=${report.status ?? "-"} events=${report.eventCount} ` +
            `stream=${report.streamId}`,
        );
      }

      expect(reports.length, `${entry.contextName} reports no seed aggregates`).toBeGreaterThan(0);
      // No aggregate may be left half-authored: `draft` after a completed
      // resume is the committed-but-incomplete shape this issue exists to fix.
      const draft = reports.filter((report) => report.kind === "draft");
      expect(draft, `${entry.contextName} left draft aggregates: ${JSON.stringify(draft)}`).toEqual([]);
      expect(
        reports.some((report) => report.kind === "active"),
        `${entry.contextName} resumed no aggregate to active`,
      ).toBe(true);
    }
    // Full-host boot case: same explicit budget the suite already uses for
    // `bootstrap-scenario.db.test.ts`'s single full-host boot.
  }, 300_000);

  it("accepts a seeded resolution after the real deadline sweep advances it to closed", async () => {
    await expectZeroRelationCaseEntry("deadline sweep resolution");

    const runtime = createHost();
    await ordinaryBoot(runtime);
    const context = requirePlatformOperationsContext(runtime);
    const supportRequests = supportRequestServices(context);
    const supportRequestId = resolvedSeedSupportRequestId;
    const beforeSweepTypes = await supportRequestStreamEventTypes(supportRequestId);
    expect(beforeSweepTypes).toContain("support.support-request.resolved");
    expect(beforeSweepTypes).not.toContain("support.support-request.closed");

    const sweep = await supportRequests.sweepSupportRequestDeadlines(
      { now: "2026-04-02T10:30:00.000Z" },
      seedActorContext,
    );

    expect(sweep.autoClosed).toBe(1);
    const afterSweepTypes = await supportRequestStreamEventTypes(supportRequestId);
    expect(afterSweepTypes).toEqual([...beforeSweepTypes, "support.support-request.closed"]);
    const afterSweepReports = await context.module.inspectSeedState!(context.pool);
    expect(afterSweepReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: supportRequestId,
          kind: "active",
          status: "closed",
        }),
      ]),
    );

    const afterSweepEventCount = await contextEventCount("platform-operations");
    await expect(context.module.seed!(context.pool, context.services, seedOptions)).resolves.toBeUndefined();
    expect(await contextEventCount("platform-operations")).toBe(afterSweepEventCount);
    const afterReconciliationReports = await context.module.inspectSeedState!(context.pool);
    expect(afterReconciliationReports.filter((report) => report.kind === "draft")).toEqual([]);
    expect(await supportRequestStreamEventTypes(supportRequestId)).toEqual(afterSweepTypes);
    console.log(
      `[#6167 pass-after] status=closed inspection=active seed-reentry-appends=0 ` +
        "counterfactual-resolved-only-complete=false",
    );
  }, 300_000);

  it("keeps a cancelled resolution-bearing seed request incomplete and does not silently repair it", async () => {
    await expectZeroRelationCaseEntry("cancelled seed request control");

    const runtime = createHost();
    await ordinaryBoot(runtime);
    const context = requirePlatformOperationsContext(runtime);
    await replaceResolvedSeedRequestWithCancelled(supportRequestServices(context));
    const supportRequestId = resolvedSeedSupportRequestId;
    const cancelledTypes = await supportRequestStreamEventTypes(supportRequestId);
    expect(cancelledTypes.at(-1)).toBe("support.support-request.cancelled");

    const beforeReconciliationEventCount = await contextEventCount("platform-operations");
    const beforeReconciliationReports = await context.module.inspectSeedState!(context.pool);
    expect(beforeReconciliationReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: supportRequestId,
          kind: "draft",
          status: "cancelled",
        }),
      ]),
    );

    await expect(context.module.seed!(context.pool, context.services, seedOptions)).rejects.toThrow();
    expect(await contextEventCount("platform-operations")).toBe(beforeReconciliationEventCount);
    expect(await supportRequestStreamEventTypes(supportRequestId)).toEqual(cancelledTypes);
    const afterReconciliationReports = await context.module.inspectSeedState!(context.pool);
    expect(afterReconciliationReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: supportRequestId,
          kind: "draft",
          status: "cancelled",
        }),
      ]),
    );
    console.log("[#6167 cancelled-control] inspection=draft seed-reentry=reject appends=0");
  }, 300_000);

  it("recreates only a missing review-eligible payment after a sibling payment has completed", async () => {
    await expectZeroRelationCaseEntry("review-eligible payment recreation");

    const runtime = createHost();
    await ordinaryBoot(runtime);

    const paymentsContext = runtime.mountedContexts.find((context) => context.contextName === "payments");
    if (!paymentsContext?.module.seed || !paymentsContext.module.inspectSeedState) {
      throw new Error("Payments context is not mounted with seed-state inspection.");
    }
    const paymentReports = (await paymentsContext.module.inspectSeedState(paymentsContext.pool)).filter(
      (report) => report.aggregateName === "Payment",
    );
    const reviewEligibleReport = paymentReports.find((report) => report.key === "review-eligible-captured");
    if (!reviewEligibleReport) {
      throw new Error("Payments seed-state inspection did not report the review-eligible payment.");
    }
    const paymentId = reviewEligibleReport.id;
    const paymentIds = paymentReports.map((report) => report.id);
    const streamId = reviewEligibleReport.streamId;
    const created = await pools.payments.query<Readonly<{ order_id: string }>>(
      `SELECT payload->'orderIds'->>0 AS order_id
       FROM event_store_events
       WHERE stream_id = $1
         AND event_type = 'payments.payment-created'`,
      [streamId],
    );
    const orderId = created.rows[0]?.order_id;
    expect(orderId, "review-eligible payment has no created order").toBeDefined();

    const beforeCrash = await paymentStreamEventCounts(paymentIds);
    expect(beforeCrash[paymentId]).toBeGreaterThan(0);

    await pools.payments.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id = $1", [streamId]);
    await pools.payments.query("DELETE FROM event_store_events WHERE stream_id = $1", [streamId]);
    await pools.payments.query(
      "UPDATE event_store_streams SET current_version = 0, updated_at = now() WHERE stream_id = $1",
      [streamId],
    );
    await pools.payments.query(
      `UPDATE payments_order_inputs
       SET status = 'pending-payment',
           ready_for_fulfillment_at = NULL
       WHERE order_id = $1`,
      [orderId],
    );
    expect((await paymentStreamEventCounts(paymentIds))[paymentId]).toBe(0);

    try {
      await paymentsContext.module.seed(paymentsContext.pool, paymentsContext.services, seedOptions);
    } catch (error) {
      console.log(
        `[#4906 F1 fail-before] error=${error instanceof Error ? error.message : String(error)} ` +
          `missing-stream-events=${(await paymentStreamEventCounts(paymentIds))[paymentId]}`,
      );
      throw error;
    }

    const afterRepair = await paymentStreamEventCounts(paymentIds);
    const siblingAppends = Object.fromEntries(
      Object.entries(afterRepair)
        .filter(([candidateId]) => candidateId !== paymentId)
        .map(([candidateId, count]) => [candidateId, count - (beforeCrash[candidateId] ?? 0)]),
    );
    expect(afterRepair[paymentId]).toBe(3);
    expect(await paymentStreamEventTypes(paymentId)).toEqual([
      "payments.payment-created",
      "payments.payment-captured",
      "payments.csat-outcome-fact.v1",
    ]);
    expect(siblingAppends).toEqual(
      Object.fromEntries(Object.keys(siblingAppends).map((candidateId) => [candidateId, 0])),
    );

    await paymentsContext.module.seed(paymentsContext.pool, paymentsContext.services, seedOptions);
    const afterSteadyState = await paymentStreamEventCounts(paymentIds);
    expect(afterSteadyState).toEqual(afterRepair);
    console.log(
      `[#4906 F1 pass-after] recreated-events=${afterRepair[paymentId]} ` +
        `sibling-appends=${JSON.stringify(siblingAppends)} next-invocation-appends=0`,
    );
  }, 300_000);
});
