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
import { expect } from "vitest";
import { createPlatformApiHost as createPlatformApiHostRuntime } from "../src/app";
import type { PlatformApiContextName } from "../src/config";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import {
  createPlatformApiRetainedStateHandoff,
  listingPhotoStorage,
  platformApiContextNames,
  type PlatformApiBootstrapTestState,
  type PlatformApiTestPools,
} from "./bootstrap-db-test-support";

const TEST_PROVIDER_MODE_OBSERVATION = {
  mode: "unconfigured",
  paymentProcessorKind: "fake",
  moneyMovementKind: "fake",
  deploymentEnvironment: "test",
} as const;

function createPlatformApiHost(options: Parameters<typeof createPlatformApiHostRuntime>[0]) {
  return createPlatformApiHostRuntime({
    ...options,
    hostPorts: {
      ...options.hostPorts,
      providerModeObservation: TEST_PROVIDER_MODE_OBSERVATION,
    },
  });
}

/**
 * Shared setup, fixtures, and helpers for the three `authoritative-seed-resume-*`
 * DB partition files. Every case body lives in one of those files; nothing here
 * declares a case, so this module is inspected by the enrollment guard for
 * listener starts and imports but enrols no cases of its own.
 *
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
export const HOST_NAME = "platform-api";
export const SETTLEMENT_PAYOUT_PROJECTION_NAME = "settlement-payout-projection";
export const PREDECESSOR_REAUTHOR_ERROR = "PREDECESSOR_WOULD_REAUTHOR_SETTLEMENT";
export const registryContextNames = apiContextRegistry.map((entry) => entry.contextName);

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
export const unloggedGuardProjectionFixture = [
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
export const seedStateExemptions = new Map<string, string>([
  ["pricing", "seed is a no-op; it authors no aggregate"],
  ["commercial-terms", "authors logged platform-policy documents, not UNLOGGED projections"],
  ["public-presence", "authors logged platform-policy documents and promo-bar rows, not UNLOGGED projections"],
]);

export type MountRole = "active" | "source-only";
export type ProfileUniverse = Readonly<{
  active: readonly string[];
  sourceOnly: readonly string[];
  omitted: readonly string[];
}>;

/**
 * Profile universes frozen on #6396. These are diagnostics: every one of them
 * is compared against the set derived from the executable manifests below, and
 * the derivation — not this table — is the authority.
 */
export const frozenProfileDiagnostics: Readonly<Record<string, ProfileUniverse>> = {
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
export const frozenEligibleScenarioSeedContexts = [
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
export const frozenInspectingSeedContexts = [
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
export const frozenNonInspectingSeedContexts = ["commercial-terms", "pricing", "public-presence"] as const;

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
export const seedInspectorDerivationSources: Readonly<Record<string, string>> = {
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
 * scenario-seed boot, in the default `Array.prototype.sort` code-unit order
 * `corpusViolations` compares with. Both the exact set and its cardinality are
 * asserted, so a dropped, renamed, or added seed aggregate fails this file, and
 * the literal's uniqueness and canonical order are asserted in the case below
 * rather than left to this comment.
 */
export const frozenSeedIdentityCorpus: readonly string[] = [
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
  "ordering|Order||off_seed_twilight_masquerade_etb",
  "ordering|Order||off_seed_twilight_masquerade_etb_encore",
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

export type CollectedSeedReport = Readonly<{
  contextName: string;
  streamPrefix: string;
  report: BcSeedAggregateStateReport;
}>;

export function seedIdentityKey(report: BcSeedAggregateStateReport): string {
  return `${report.contextName}|${report.aggregateName}|${report.id}|${report.key}`;
}

function corpusIdentityKey(report: BcSeedAggregateStateReport): string {
  if (
    report.contextName === "ordering" &&
    report.aggregateName === "Order" &&
    orderingOfferAcceptanceSourceToFallbackOrderId.has(report.key)
  ) {
    return `${report.contextName}|${report.aggregateName}||${report.key}`;
  }
  return seedIdentityKey(report);
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
export const seedReportStreamPrefixExceptions = new Map<string, string>([
  ["platform-operations|Support Request", "support.support-request-"],
]);

export function reportStreamPrefixKey(entry: CollectedSeedReport): string {
  return `${entry.contextName}|${entry.report.aggregateName}`;
}

export function allowedReportStreamPrefix(entry: CollectedSeedReport): string {
  return seedReportStreamPrefixExceptions.get(reportStreamPrefixKey(entry)) ?? entry.streamPrefix;
}

/**
 * Ownership binding: every report names the context it was collected from and a
 * stream that context's module actually owns. Nothing here trusts the report.
 */
export function mountBindingViolations(entries: readonly CollectedSeedReport[]): readonly string[] {
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
export function eventCountBindingViolations(
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

export function corpusViolations(entries: readonly CollectedSeedReport[]): readonly string[] {
  const derived = entries.map((entry) => corpusIdentityKey(entry.report)).sort();
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
 * offer-acceptance reaction already committed. The map declares each source's
 * reserved empty-stream fallback without positional correspondence.
 */
export const orderingOfferAcceptanceSourceToFallbackOrderId: ReadonlyMap<string, string> = new Map([
  ["off_seed_twilight_masquerade_etb", "ord_seed_offer_ready"],
  ["off_seed_twilight_masquerade_etb_encore", "ord_seed_review_eligible"],
]);

export const orderingOfferAcceptanceSourceIdentityQuery = `SELECT payload->>'orderId' AS order_id
       FROM event_store_events
      WHERE event_type = 'ordering.order.created'
        AND payload->>'sourceType' = 'offer-acceptance'
        AND payload->>'sourceReferenceId' = $1
      ORDER BY 1 ASC`;

export async function orderStreamsForOfferSource(sourceReferenceId: string): Promise<readonly string[]> {
  const result = await pools.ordering.query<Readonly<{ order_id: string }>>(
    orderingOfferAcceptanceSourceIdentityQuery,
    [sourceReferenceId],
  );
  return result.rows.map((row) => row.order_id);
}

export type OrderingOfferAcceptanceReportDerivation = Readonly<{
  sourceReferenceId: string;
  fallbackOrderId: string;
  reportedId: string;
  resolvedSourceOrderId: string;
  actualEventCount: number;
  arm: "source-resolved-active" | "reserved-fallback-absent";
  query: string;
}>;

export type OrderingOfferAcceptanceReportReconciliation = Readonly<{
  derivations: readonly OrderingOfferAcceptanceReportDerivation[];
  violations: readonly string[];
}>;

export function deriveOrderingOfferAcceptanceReportReconciliation(
  entries: readonly CollectedSeedReport[],
  actualStreamEventCounts: ReadonlyMap<string, number>,
  sourceResolvedOrderIds: ReadonlyMap<string, string>,
): OrderingOfferAcceptanceReportReconciliation {
  const derivations: OrderingOfferAcceptanceReportDerivation[] = [];
  const violations: string[] = [];

  for (const [sourceReferenceId, fallbackOrderId] of orderingOfferAcceptanceSourceToFallbackOrderId) {
    const matching = entries.filter(
      ({ contextName, report }) =>
        contextName === "ordering" &&
        report.contextName === "ordering" &&
        report.aggregateName === "Order" &&
        report.key === sourceReferenceId,
    );
    if (matching.length !== 1) {
      violations.push(`ordering offer source '${sourceReferenceId}' has ${matching.length} reports instead of one`);
      continue;
    }

    const report = matching[0]!.report;
    const resolvedSourceOrderId = sourceResolvedOrderIds.get(sourceReferenceId);
    if (resolvedSourceOrderId === undefined) {
      violations.push(`ordering offer source '${sourceReferenceId}' has no source-resolved order id`);
      continue;
    }
    const actualEventCount = actualStreamEventCounts.get(`ordering|${report.streamId}`);
    if (actualEventCount === undefined) {
      violations.push(`ordering offer source '${sourceReferenceId}' stream '${report.streamId}' was never counted`);
      continue;
    }

    const arm = actualEventCount > 0 ? "source-resolved-active" : "reserved-fallback-absent";
    derivations.push({
      sourceReferenceId,
      fallbackOrderId,
      reportedId: report.id,
      resolvedSourceOrderId,
      actualEventCount,
      arm,
      query: orderingOfferAcceptanceSourceIdentityQuery,
    });

    if (report.eventCount !== actualEventCount) {
      violations.push(
        `ordering offer source '${sourceReferenceId}' reports ${report.eventCount} events but its stream holds ${actualEventCount}`,
      );
    }
    if (arm === "source-resolved-active") {
      if (report.id !== resolvedSourceOrderId) {
        violations.push(
          `ordering offer source '${sourceReferenceId}' reports id '${report.id}' instead of source-resolved '${resolvedSourceOrderId}'`,
        );
      }
      if (report.kind !== "active") {
        violations.push(
          `ordering offer source '${sourceReferenceId}' has ${actualEventCount} events but reports kind '${report.kind}'`,
        );
      }
      continue;
    }

    if (report.id !== fallbackOrderId) {
      violations.push(
        `ordering offer source '${sourceReferenceId}' reports empty-stream id '${report.id}' instead of fallback '${fallbackOrderId}'`,
      );
    }
    if (report.kind !== "absent" || report.eventCount !== 0) {
      violations.push(
        `ordering offer source '${sourceReferenceId}' has an empty stream but reports kind '${report.kind}' and ${report.eventCount} events`,
      );
    }
  }

  return { derivations, violations };
}

export async function orderStreamEventTypes(orderId: string): Promise<readonly string[]> {
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
 *
 * The column list is not transcribed from prose. It must cover every column of
 * the canonical `public_presence_promo_bar_messages` table except the single
 * intentional exclusion, and `promoSchemaParityViolations` asserts exactly that
 * against the live relation the freeze reads, so a column added to the read
 * model can never silently fall outside the freeze. `starts_at`/`ends_at` are
 * the promo scheduling window `promoBarStatus` and the live visibility query
 * both consume; the seed never writes them, which is what the schedule-window
 * mutant in phase two proves.
 */
export type PromoBarSemanticRow = Readonly<{
  id: string;
  title: string;
  description: string | null;
  href: string | null;
  link_label: string | null;
  tone: string;
  is_active: boolean;
  display_order: number;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
}>;
export type PromoBarRow = PromoBarSemanticRow & Readonly<{ updated_at: string }>;
export type PolicyDocumentSemanticRow = Readonly<{
  document_id: string;
  context_name: string;
  status: string;
  value: unknown;
  effective_from: string;
  effective_until: string | null;
  created_at: string;
}>;
export type PolicyDocumentStream = Readonly<{ stream_id: string; event_count: number }>;
export type PublicPresenceSeedOutput = Readonly<{
  promoRows: readonly PromoBarRow[];
  promoSemantic: readonly PromoBarSemanticRow[];
  policyRow: PolicyDocumentSemanticRow;
  policyStreams: readonly PolicyDocumentStream[];
  activePolicyCount: number;
}>;

export const publicPresenceSeedPromoIds = ["pbm_seed_beta_listing_fees", "pbm_seed_shipping_credit"] as const;
export const publicPresenceBetaWavePolicyKey = "public-presence.beta-waves";
export const policyDocumentStreamPrefix = "platform-policy.document-";
export const publicPresencePromoTableName = "public_presence_promo_bar_messages";

/**
 * The sole authorized omission from the promo freeze: the column the seed
 * deliberately rewrites on every pass. Every other canonical column must be
 * frozen, which `promoSchemaParityViolations` enforces executably.
 */
export const promoIntentionallyExcludedColumns = ["updated_at"] as const;

export function promoSemanticColumns(row: PromoBarRow): PromoBarSemanticRow {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    href: row.href,
    link_label: row.link_label,
    tone: row.tone,
    is_active: row.is_active,
    display_order: row.display_order,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    created_at: row.created_at,
  };
}

export function promoFrozenMismatches(
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
export function promoIdAndOrderMismatches(
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

export async function publicPresencePromoRows(): Promise<readonly PromoBarRow[]> {
  const result = await pools["public-presence"].query<PromoBarRow>(
    `SELECT id, title, description, href, link_label, tone, is_active, display_order,
            starts_at::text AS starts_at, ends_at::text AS ends_at,
            created_at::text AS created_at, updated_at::text AS updated_at
       FROM public_presence_promo_bar_messages
      WHERE id = ANY($1::text[])
      ORDER BY id ASC`,
    [[...publicPresenceSeedPromoIds]],
  );
  return result.rows;
}

/**
 * The canonical column set of the relation `publicPresencePromoRows` actually
 * reads. `to_regclass` resolves through the same connection's `search_path`, so
 * this is the table the freeze queries, not a same-named table in another
 * schema.
 */
export async function publicPresencePromoTableColumns(): Promise<readonly string[]> {
  const result = await pools["public-presence"].query<Readonly<{ column_name: string }>>(
    `SELECT attname AS column_name
       FROM pg_attribute
      WHERE attrelid = to_regclass($1)
        AND attnum > 0
        AND NOT attisdropped
      ORDER BY attname ASC`,
    [publicPresencePromoTableName],
  );
  return result.rows.map((row) => row.column_name);
}

/**
 * Executable schema-to-freeze parity. The frozen projection's own key set —
 * taken from a captured row, so it is what `promoSemanticColumns` really
 * produces rather than a second hand-written list — plus the single authorized
 * exclusion must equal the canonical table exactly. A promo column that is
 * neither frozen nor deliberately excluded is a silent hole in the freeze, and
 * that is the omission #6484 F1 found.
 */
export function promoSchemaParityViolations(
  semantic: readonly PromoBarSemanticRow[],
  schemaColumns: readonly string[],
): readonly string[] {
  const violations: string[] = [];
  const sample = semantic[0];
  if (!sample) {
    return ["the promo freeze captured no rows, so its column coverage cannot be established"];
  }
  if (schemaColumns.length === 0) {
    return [`'${publicPresencePromoTableName}' did not resolve on the Public Presence search_path`];
  }
  const frozenColumns = Object.keys(sample).sort();
  const accountedFor = new Set([...frozenColumns, ...promoIntentionallyExcludedColumns]);
  for (const column of schemaColumns) {
    if (!accountedFor.has(column)) {
      violations.push(`canonical promo column '${column}' is neither frozen nor intentionally excluded`);
    }
  }
  const schemaColumnSet = new Set(schemaColumns);
  for (const column of accountedFor) {
    if (!schemaColumnSet.has(column)) {
      violations.push(`'${column}' is accounted for by the freeze but is not a column of the canonical table`);
    }
  }
  // Every captured row must carry the same key set, or the parity established
  // from `sample` would not hold for the rows actually compared.
  for (const row of semantic) {
    const rowColumns = Object.keys(row).sort();
    if (rowColumns.join(",") !== frozenColumns.join(",")) {
      violations.push(`promo row '${row.id}' projects ${rowColumns.join(",")}, not ${frozenColumns.join(",")}`);
    }
  }
  return violations;
}

export function describePromoSchemaParity(
  semantic: readonly PromoBarSemanticRow[],
  schemaColumns: readonly string[],
): string {
  const frozenColumns = Object.keys(semantic[0] ?? {}).sort();
  const accountedFor = new Set([...frozenColumns, ...promoIntentionallyExcludedColumns]);
  return (
    `[#6490 promo schema parity] schemaColumns=${schemaColumns.join(",")}; ` +
    `frozenColumns=${frozenColumns.join(",")}; ` +
    `intentionallyExcluded=${[...promoIntentionallyExcludedColumns].join(",")}; ` +
    `missingSemanticColumns=${schemaColumns.filter((column) => !accountedFor.has(column)).join(",") || "(none)"}`
  );
}

export async function publicPresenceBetaWavePolicyRow(): Promise<PolicyDocumentSemanticRow | undefined> {
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
export async function publicPresencePolicyDocumentStreams(): Promise<readonly PolicyDocumentStream[]> {
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

export async function publicPresenceActivePolicyCount(): Promise<number> {
  const result = await pools["public-presence"].query<Readonly<{ count: string }>>(
    "SELECT COUNT(*) AS count FROM platform_policy_documents WHERE status = 'active'",
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function capturePublicPresenceSeedOutput(): Promise<PublicPresenceSeedOutput> {
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

export type RetainedStatePhaseOneReceipt = Readonly<{
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
export const RETAINED_STATE_PHASE_TWO_CASE =
  "retained-state phase two: proves ordinary boot two appends nothing on the retained phase-one database";
export const retainedStatePhaseHandoff =
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
export function deriveProfileUniverse(runtimeProfile: PlatformApiRuntimeProfile | undefined): ProfileUniverse {
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
export function executableProfileUniverse(runtimeProfile: PlatformApiRuntimeProfile): ProfileUniverse {
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

export function formatUniverse(label: string, universe: ProfileUniverse): string {
  return (
    `[#6396 universe] ${label}: active(${universe.active.length})=${universe.active.join(",") || "-"} | ` +
    `source-only(${universe.sourceOnly.length})=${universe.sourceOnly.join(",") || "-"} | ` +
    `omitted(${universe.omitted.length})=${universe.omitted.join(",") || "-"}`
  );
}

export type EligibleSeedContext = Readonly<{
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
export function eligibleScenarioSeedContexts(runtime: ApiHostRuntime): readonly EligibleSeedContext[] {
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
export async function eligiblePrefixCounts(runtime: ApiHostRuntime): Promise<Readonly<Record<string, number>>> {
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
export async function activeContextRelationCounts(): Promise<Readonly<Record<string, number>>> {
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
export async function repeatSameBootSeedLifecyclePoint(runtime: ApiHostRuntime): Promise<void> {
  for (const contextName of getApiHostSeedOrder(apiContextRegistry, HOST_NAME, undefined, seedOptions)) {
    const context = runtime.mountedContexts.find((entry) => entry.contextName === contextName);
    if (!context?.module.seed || !seedProfilesOverlap(context.module.seedProfiles, seedOptions)) {
      continue;
    }
    await context.module.seed(context.pool, context.services, seedOptions);
  }
}

export const settlementPayoutCheckpointKey = createCheckpointKey({
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
export const settlementSeedCompletedPayoutId = "pyo_seed_completed";
export const settlementSeedFailedPayoutId = "pyo_seed_failed";
export const settlementSeedPendingSaleCreditId = "led_seed_pending_sale_credit";
export const seededPayoutIds = [settlementSeedCompletedPayoutId, settlementSeedFailedPayoutId] as const;
export const settlementSeedPrerequisitePaymentId = "pay_seed_offer_captured";
export const settlementSeedSellerAccountId = identitySeedIds.demo.accountId;

/**
 * Clones the executable `landing` runtime, removing only the
 * `projectionHandlerSet` whose `projectionName` is
 * `settlement-payout-projection`. Every other handler set, service, pool, and
 * mount role is the identical object the host resolved. Under `landing`
 * Settlement is source-only, so `resolveModuleSubscriptions` skips it entirely
 * and this local handler set is the sole writer of `settlement_payout_pages`.
 */
export function withLaggingSettlementPayoutProjection(runtime: ApiHostRuntime): ApiHostRuntime {
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

export async function settlementPayoutPageIds(): Promise<readonly string[]> {
  const result = await pools.settlement.query<Readonly<{ payout_id: string }>>(
    "SELECT payout_id FROM settlement_payout_pages ORDER BY payout_id ASC",
  );
  return result.rows.map((row) => row.payout_id);
}

export type SettlementPrerequisiteRow = Readonly<{
  payment_id: string;
  amount: string;
  currency_code: string;
  status: string;
  captured_at: string | null;
}>;

export async function settlementPaymentSourceRows(): Promise<readonly SettlementPrerequisiteRow[]> {
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
export async function rollWalletReleaseEventOffTheStream(
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
export async function payoutsMissingFromStreams(): Promise<readonly string[]> {
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
export async function predecessorEmptyProjectionSeedDecision(): Promise<readonly string[]> {
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

export const requiredDraftListingId = "lst_seed_lugia_neo_genesis_draft";
export const resolvedSeedSupportRequestId = "sup_seed_resolved_partial_refund";
export const resolvedSeedBuyerAttestationId = "sev_seed_resolved_buyer_attestation";
export const resolvedSeedPhotoId = "sev_seed_resolved_photo";

/**
 * Shared connection state for the three `authoritative-seed-resume-*` partition
 * files. Each of those files owns its own `createPlatformApiBootstrapTestHarness`
 * call — and therefore its own database suffix — and hands the harness this
 * assignment function, so the helpers below bind to whichever partition file is
 * currently executing. Vitest isolates module state per test file, so the three
 * files never share a live binding at run time.
 */
export let pools: PlatformApiTestPools;
export function assignAuthoritativeSeedResumeState(state: PlatformApiBootstrapTestState): void {
  pools = state.pools;
}

/**
 * Zero-relation case-entry receipt. The harness reset is total — `DROP OWNED BY
 * CURRENT_USER CASCADE` leaves each context database with no relations at all,
 * `event_store_events` included — so a case that resets enters at zero
 * everywhere. Every case in this file except the named retained-state phase two
 * asserts this, which is what proves the opt-in handoff did not leak.
 */
export async function expectZeroRelationCaseEntry(caseLabel: string): Promise<void> {
  expect(platformApiContextNames).toHaveLength(19);
  const relations = await activeContextRelationCounts();
  expect(relations, `case entry for '${caseLabel}': ${JSON.stringify(relations)}`).toEqual(
    Object.fromEntries(platformApiContextNames.map((contextName) => [contextName, 0])),
  );
  console.log(
    `[#6490 case-entry] '${caseLabel}': 0 relations in all ${platformApiContextNames.length} active context databases`,
  );
}

export type SeedingModule = Pick<BcApiModule<unknown, unknown, unknown>, "contextName" | "seed" | "inspectSeedState">;
export type SeedLifecycleSupportRequests = Readonly<{
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
export type SupportSeedOrderSource = Readonly<{
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
export function createHost(runtimeProfile: PlatformApiRuntimeProfile = "public") {
  return createPlatformApiHost({
    runtimeProfile,
    pools,
    hostPorts: {
      processorGateway: createFakePaymentProcessorGateway(),
      listingPhotoStorage,
    },
  });
}

export const seedOptions: BcSeedOptions = {
  enabledDataProfiles: ["critical-bootstrap", "catalog-integration-bootstrap", "scenario-seed"],
  environmentName: "test",
};

export async function ordinaryBoot(runtime: ReturnType<typeof createHost>): Promise<void> {
  await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, seedOptions);
}

/**
 * Re-invokes every mounted context's `seed` in host seed order, which is the
 * caller shape `platform-runtime/api.ts` uses at `:468` (seed), `:475`
 * (`projection-drain:<context>`), and `:494` (`seed-reconcile:<context>`)
 * within a single boot.
 */
export async function invokeConvertedSeeds(runtime: ReturnType<typeof createHost>): Promise<void> {
  for (const entry of unloggedGuardProjectionFixture) {
    const context = runtime.mountedContexts.find((mounted) => mounted.contextName === entry.contextName);
    if (!context?.module.seed) {
      throw new Error(`Context '${entry.contextName}' is not mounted with a seed.`);
    }
    await context.module.seed(context.pool, context.services, seedOptions);
  }
}

export function seedingModules(runtime: ReturnType<typeof createHost>): readonly SeedingModule[] {
  return runtime.mountedModules.map((entry) => entry.module as SeedingModule).filter((module) => Boolean(module.seed));
}

export function poolFor(contextName: string) {
  return pools[contextName as PlatformApiContextName];
}

export function requirePlatformOperationsContext(runtime: ReturnType<typeof createHost>) {
  const context = runtime.mountedContexts.find((mounted) => mounted.contextName === "platform-operations");
  if (!context?.module.seed || !context.module.inspectSeedState) {
    throw new Error("Platform Operations is not mounted with seed reconciliation and inspection.");
  }
  return context;
}

export function supportRequestServices(context: ReturnType<typeof requirePlatformOperationsContext>) {
  return (context.services as unknown as Readonly<{ supportRequests: SeedLifecycleSupportRequests }>).supportRequests;
}

export const seedActorContext = {
  tenantId: "tnt_seed_development",
  audit: {
    performedByUserId: "usr_test_issue_6167",
    forAccountId: "acc_test_issue_6167",
  },
} as EventStoreContext;

export async function contextEventCount(contextName: string): Promise<number> {
  const result = await poolFor(contextName).query<Readonly<{ count: string }>>(
    "SELECT COUNT(*) AS count FROM event_store_events",
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function allContextEventCounts(): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const entry of unloggedGuardProjectionFixture) {
    counts[entry.contextName] = await contextEventCount(entry.contextName);
  }
  return counts;
}

export async function paymentStreamEventCounts(
  paymentIds: readonly string[],
): Promise<Readonly<Record<string, number>>> {
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

export async function paymentStreamEventTypes(paymentId: string): Promise<readonly string[]> {
  const result = await pools.payments.query<Readonly<{ event_type: string }>>(
    "SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC",
    [`payments.payment-${paymentId}`],
  );
  return result.rows.map((row) => row.event_type);
}

export async function supportRequestStreamEventTypes(supportRequestId: string): Promise<readonly string[]> {
  const result = await pools["platform-operations"].query<Readonly<{ event_type: string }>>(
    "SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC",
    [`support.support-request-${supportRequestId}`],
  );
  return result.rows.map((row) => row.event_type);
}

export async function replaceResolvedSeedRequestWithCancelled(
  supportRequests: SeedLifecycleSupportRequests,
): Promise<void> {
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

export function summarizeStates(reports: readonly BcSeedAggregateStateReport[]): string {
  const byKind = new Map<string, number>();
  for (const report of reports) {
    byKind.set(report.kind, (byKind.get(report.kind) ?? 0) + 1);
  }
  return [...byKind.entries()].map(([kind, count]) => `${kind}=${count}`).join(" ");
}
