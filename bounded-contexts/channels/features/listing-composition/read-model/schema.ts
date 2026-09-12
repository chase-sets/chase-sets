import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const publicationOperationTable = `CREATE TABLE IF NOT EXISTS channels_channel_publication_operations (
  operation_id text PRIMARY KEY, channel_listing_id text NOT NULL,
  desired_state_sequence bigint NOT NULL, listing_revision bigint NOT NULL,
  desired_state_hash text NOT NULL CHECK (desired_state_hash ~ '^[a-f0-9]{64}$'),
  bound_at timestamptz NOT NULL
)`;

const inventoryAllocationFactTable = `CREATE TABLE IF NOT EXISTS channels_inventory_allocation_facts (
  item_id text PRIMARY KEY, account_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('shared-pool','partitioned')),
  partitions jsonb NOT NULL, updated_at timestamptz NOT NULL,
  allocation_stream_version bigint NOT NULL CHECK (allocation_stream_version >= 1)
)`;

const tables = [
  `CREATE TABLE IF NOT EXISTS channels_listing_publication_facts (
    listing_id text PRIMARY KEY, account_id text NOT NULL, inventory_item_id text NOT NULL, catalog_item_id text NOT NULL,
    price_amount text NULL, price_currency_code text NULL, quantity_cap integer NOT NULL,
    selected_options jsonb NOT NULL, selected_option_key text NOT NULL,
    listing_status text NOT NULL CHECK (listing_status IN ('draft','active','paused','withdrawn','auto-unlisted')),
    pause_reason text NULL, item_title text NULL, item_subtitle text NULL, product_summary text NULL, graded_card jsonb NULL,
    updated_at timestamptz NOT NULL, listing_stream_version bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channels_seller_availability_facts (
    account_id text PRIMARY KEY, status text NOT NULL CHECK (status IN ('available','unavailable')),
    reason_category text NULL, available_again_at timestamptz NULL, updated_at timestamptz NOT NULL,
    availability_stream_version bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channels_inventory_item_facts (
    item_id text PRIMARY KEY, account_id text NOT NULL, catalog_item_id text NOT NULL, total_quantity integer NOT NULL,
    updated_at timestamptz NOT NULL, item_stream_version bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channels_inventory_hold_facts (
    hold_id text PRIMARY KEY, item_id text NOT NULL, quantity integer NOT NULL,
    status text NOT NULL CHECK (status IN ('active','released','expired','consumed')),
    updated_at timestamptz NOT NULL, hold_stream_version bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channels_catalog_item_category_facts (
    catalog_item_id text NOT NULL, category_id text NOT NULL, assigned boolean NOT NULL,
    updated_at timestamptz NOT NULL, catalog_item_stream_version bigint NOT NULL,
    PRIMARY KEY (catalog_item_id, category_id)
  )`,
  `CREATE TABLE IF NOT EXISTS channels_external_product_reference_facts (
    provider_key text NOT NULL, external_key text NOT NULL, catalog_item_id text NOT NULL,
    selected_options jsonb NOT NULL, selected_option_key text NOT NULL,
    link_state text NOT NULL CHECK (link_state IN ('linked','unlinked')),
    updated_at timestamptz NOT NULL, reference_stream_version bigint NOT NULL,
    PRIMARY KEY (provider_key, external_key)
  )`,
  `CREATE TABLE IF NOT EXISTS channels_external_catalog_item_reference_facts (
    provider_key text NOT NULL, external_key text NOT NULL, catalog_item_id text NOT NULL,
    link_state text NOT NULL CHECK (link_state IN ('linked','unlinked')),
    updated_at timestamptz NOT NULL, reference_stream_version bigint NOT NULL,
    PRIMARY KEY (provider_key, external_key)
  )`,
  `CREATE TABLE IF NOT EXISTS channels_connection_facts (
    connection_id text PRIMARY KEY, account_id text NOT NULL, provider_key text NOT NULL,
    environment text NOT NULL CHECK (environment IN ('sandbox','production')),
    status text NOT NULL CHECK (status IN ('pending-setup','active','paused','disconnected')),
    updated_at timestamptz NOT NULL, connection_stream_version bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channels_connection_publication_settings (
    connection_id text PRIMARY KEY, title_prefix text NOT NULL, title_suffix text NOT NULL,
    description_footer text NOT NULL, category_allowlist jsonb NOT NULL, excluded_listing_ids jsonb NOT NULL,
    updated_at timestamptz NOT NULL, last_stream_version bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channels_channel_mappings (
    connection_id text NOT NULL, dimension text NOT NULL CHECK (dimension IN ('category','condition','attribute')),
    source_key text NOT NULL, target_key text NULL,
    confidence_tier text NOT NULL CHECK (confidence_tier IN ('manual','high','medium','low')),
    review_status text NOT NULL CHECK (review_status IN ('proposed','accepted','auto-accepted','rejected','revoked')),
    provenance text NOT NULL CHECK (provenance IN ('compose-discovered','export-discovered','operator')),
    evidence jsonb NOT NULL, updated_at timestamptz NOT NULL, last_stream_version bigint NOT NULL,
    PRIMARY KEY (connection_id, dimension, source_key),
    CHECK (review_status NOT IN ('accepted','auto-accepted') OR target_key IS NOT NULL)
  )`,
  `CREATE TABLE IF NOT EXISTS channels_channel_listing_links (
    connection_id text NOT NULL, listing_id text NOT NULL, channel_listing_id text NOT NULL UNIQUE,
    external_listing_id text NULL, external_offer_id text NULL, provider_revision text NULL,
    last_desired_state_sequence bigint NULL, last_desired_listing_revision bigint NULL,
    last_desired_state_hash text NULL, last_desired_intent text NULL,
    last_desired_payload jsonb NULL,
    last_pushed_listing_revision bigint NULL, last_pushed_price_amount_minor bigint NULL,
    last_pushed_price_currency text NULL, last_pushed_quantity integer NULL,
    publish_state text NOT NULL CHECK (publish_state IN ('pending','published','delisted','failed','blocked')),
    blocking_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb, failure_reason text NULL,
    drift_status text NULL, operation_bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL, last_stream_version bigint NOT NULL,
    PRIMARY KEY (connection_id, listing_id)
  )`,
  `CREATE TABLE IF NOT EXISTS channels_listing_reconciliation_runs (
    run_id text PRIMARY KEY, connection_id text NOT NULL,
    scope text NOT NULL CHECK (scope IN ('connection','account','catalog-item','inventory-item')),
    scope_key text NOT NULL, cursor_listing_id text NULL, restart_required boolean NOT NULL DEFAULT false,
    processed_count integer NOT NULL DEFAULT 0,
    state text NOT NULL CHECK (state IN ('pending','draining','complete','failed')),
    failure_code text NULL, attempt_count integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL, last_stream_version bigint NOT NULL
  )`,
  publicationOperationTable,
] as const;

const indexes = [
  "CREATE INDEX IF NOT EXISTS channels_listing_facts_account_idx ON channels_listing_publication_facts (account_id, listing_id)",
  "CREATE INDEX IF NOT EXISTS channels_listing_facts_inventory_idx ON channels_listing_publication_facts (inventory_item_id, listing_id)",
  "CREATE INDEX IF NOT EXISTS channels_listing_facts_catalog_idx ON channels_listing_publication_facts (catalog_item_id, listing_id)",
  "CREATE INDEX IF NOT EXISTS channels_active_holds_item_idx ON channels_inventory_hold_facts (item_id) WHERE status = 'active'",
  "CREATE INDEX IF NOT EXISTS channels_linked_product_reference_idx ON channels_external_product_reference_facts (provider_key, catalog_item_id, selected_option_key) WHERE link_state = 'linked'",
  "CREATE INDEX IF NOT EXISTS channels_linked_catalog_reference_idx ON channels_external_catalog_item_reference_facts (provider_key, catalog_item_id) WHERE link_state = 'linked'",
  "CREATE INDEX IF NOT EXISTS channels_mapping_review_queue_idx ON channels_channel_mappings (connection_id, dimension, source_key) WHERE review_status NOT IN ('accepted','auto-accepted')",
  "CREATE UNIQUE INDEX IF NOT EXISTS channels_live_reconciliation_scope_idx ON channels_listing_reconciliation_runs (connection_id, scope, scope_key) WHERE state IN ('pending','draining')",
] as const;

const migrationIndexes = [
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_listing_facts_account_idx ON channels_listing_publication_facts (account_id, listing_id)",
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_listing_facts_inventory_idx ON channels_listing_publication_facts (inventory_item_id, listing_id)",
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_listing_facts_catalog_idx ON channels_listing_publication_facts (catalog_item_id, listing_id)",
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_active_holds_item_idx ON channels_inventory_hold_facts (item_id) WHERE status = 'active'",
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_linked_product_reference_idx ON channels_external_product_reference_facts (provider_key, catalog_item_id, selected_option_key) WHERE link_state = 'linked'",
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_linked_catalog_reference_idx ON channels_external_catalog_item_reference_facts (provider_key, catalog_item_id) WHERE link_state = 'linked'",
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_mapping_review_queue_idx ON channels_channel_mappings (connection_id, dimension, source_key) WHERE review_status NOT IN ('accepted','auto-accepted')",
  "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS channels_live_reconciliation_scope_idx ON channels_listing_reconciliation_runs (connection_id, scope, scope_key) WHERE state IN ('pending','draining')",
] as const;

export const channelListingCompositionSchemaSql = `${tables.join(";\n")};\n${inventoryAllocationFactTable};\n${indexes.join(";\n")};`;

export const channelListingCompositionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260908_channels_listing_desired_state",
    description: "Create the twelve Channel Publication Facts, configuration, Link, and reconciliation projections.",
    statements: [...tables.filter((table) => table !== publicationOperationTable), ...migrationIndexes],
  },
  {
    migrationId: "20260909_channels_publication_operation_identity",
    description: "Fence each publication operation ID to one Channel Listing desired-state tuple.",
    statements: [publicationOperationTable],
  },
  {
    migrationId: "20260911_channels_inventory_allocation_facts",
    description: "Project Inventory Channel Stock Allocation facts for connection-aware desired state.",
    statements: [inventoryAllocationFactTable],
  },
];

export const channelListingCompositionTableNames = [
  "channels_listing_publication_facts",
  "channels_seller_availability_facts",
  "channels_inventory_item_facts",
  "channels_inventory_hold_facts",
  "channels_inventory_allocation_facts",
  "channels_catalog_item_category_facts",
  "channels_external_product_reference_facts",
  "channels_external_catalog_item_reference_facts",
  "channels_connection_facts",
  "channels_connection_publication_settings",
  "channels_channel_mappings",
  "channels_channel_listing_links",
  "channels_listing_reconciliation_runs",
  "channels_channel_publication_operations",
] as const;
