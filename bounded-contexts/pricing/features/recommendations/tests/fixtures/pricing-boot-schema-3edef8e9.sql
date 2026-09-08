-- Provenance commit: 3edef8e981847f1aa16c97e13efcdeda7063608e
-- Raw evaluated SQL SHA-256: ea46df37b030b6639c103642332683852ede8b08d295f5e57c68a2829e981b93
-- Derivation: git archive --format=tar --output=$archivePath 3edef8e981847f1aa16c97e13efcdeda7063608e
-- Derivation: tar -xf $archivePath -C $fixtureRoot; pnpm install --offline --frozen-lockfile --ignore-scripts
-- Derivation: pnpm exec tsx -e "import('./bounded-contexts/pricing/support/runtime-support/schema.ts').then(({ pricingSchemaSql }) => require('node:fs').writeFileSync('.fixture-schema.sql', pricingSchemaSql, 'utf8'))"

CREATE TABLE IF NOT EXISTS event_store_streams (
  stream_id text PRIMARY KEY,
  current_version bigint NOT NULL CHECK (current_version >= 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS event_store_events (
  global_position bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  stream_id text NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  tenant_id text NOT NULL,
  stream_context_name text NOT NULL,
  stream_category text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  performed_by_user_id text NOT NULL,
  for_account_id text NOT NULL,
  trace_id text NULL,
  span_id text NULL,
  parent_span_id text NULL,
  trace_state text NULL,
  CONSTRAINT event_store_events_stream_version_uk UNIQUE (
    stream_id,
    stream_version
  ),
  CONSTRAINT event_store_events_stream_fk
    FOREIGN KEY (stream_id)
    REFERENCES event_store_streams (stream_id)
    ON DELETE CASCADE
);

-- Gap-safe catch-up horizons read the sequence's last allocated position after
-- fencing concurrent append transactions. CACHE 1 is part of that invariant:
-- a larger cache could issue a future position below the captured last_value.
ALTER SEQUENCE event_store_events_global_position_seq CACHE 1;

ALTER TABLE event_store_events
  ADD COLUMN IF NOT EXISTS stream_context_name text NULL,
  ADD COLUMN IF NOT EXISTS stream_category text NULL,
  ADD COLUMN IF NOT EXISTS trace_id text NULL,
  ADD COLUMN IF NOT EXISTS span_id text NULL,
  ADD COLUMN IF NOT EXISTS parent_span_id text NULL,
  ADD COLUMN IF NOT EXISTS trace_state text NULL,
  DROP COLUMN IF EXISTS correlation_id,
  DROP COLUMN IF EXISTS causation_id,
  DROP COLUMN IF EXISTS command_id;

CREATE INDEX IF NOT EXISTS event_store_events_stream_idx
  ON event_store_events (stream_id, stream_version ASC);

CREATE INDEX IF NOT EXISTS event_store_events_global_idx
  ON event_store_events (global_position ASC);

CREATE INDEX IF NOT EXISTS event_store_events_tenant_global_idx
  ON event_store_events (tenant_id, global_position ASC);

CREATE INDEX IF NOT EXISTS event_store_events_type_idx
  ON event_store_events (event_type);

CREATE INDEX IF NOT EXISTS event_store_events_type_global_idx
  ON event_store_events (event_type, global_position ASC);

CREATE INDEX IF NOT EXISTS event_store_events_tenant_type_global_idx
  ON event_store_events (tenant_id, event_type, global_position ASC);

CREATE INDEX IF NOT EXISTS event_store_events_stream_prefix_global_idx
  ON event_store_events (stream_id text_pattern_ops, global_position ASC);

CREATE INDEX IF NOT EXISTS event_store_events_context_category_type_global_idx
  ON event_store_events (stream_context_name, stream_category, event_type, global_position ASC);

CREATE INDEX IF NOT EXISTS event_store_events_context_category_global_idx
  ON event_store_events (stream_context_name, stream_category, global_position ASC);

-- Load-time cache, never a source of truth: the event stream
-- above stays canonical, and this table must always be safe to truncate or
-- fully rebuild from events. `schema_version` lets the aggregate repository
-- detect a stale snapshot after an evolver change and fall back to full
-- replay instead of misapplying it. See contracts/event-core/README.md.
CREATE TABLE IF NOT EXISTS event_store_aggregate_snapshots (
  stream_id text PRIMARY KEY,
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT event_store_aggregate_snapshots_stream_fk
    FOREIGN KEY (stream_id)
    REFERENCES event_store_streams (stream_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_projection_checkpoints (
  projector_name text PRIMARY KEY,
  last_global_position bigint NOT NULL CHECK (last_global_position >= 0),
  updated_at timestamptz NOT NULL
);

CREATE UNLOGGED TABLE IF NOT EXISTS event_projection_recovery_markers (
  projection_kind text NOT NULL CHECK (projection_kind IN ('projector', 'subscription')),
  projection_key text NOT NULL,
  last_global_position bigint NOT NULL CHECK (last_global_position >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (projection_kind, projection_key)
);

CREATE TABLE IF NOT EXISTS event_projection_poison_events (
  projection_key text NOT NULL,
  event_id text NOT NULL,
  projection_name text NOT NULL,
  projection_kind text NOT NULL CHECK (projection_kind IN ('projector', 'subscription')),
  target_context_name text NULL,
  source_context_name text NULL,
  projection_revision integer NULL CHECK (projection_revision IS NULL OR projection_revision >= 1),
  subscription_version integer NULL CHECK (subscription_version IS NULL OR subscription_version >= 1),
  stream_id text NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  event_type text NOT NULL,
  global_position bigint NOT NULL CHECK (global_position >= 0),
  failure_kind text NOT NULL CHECK (failure_kind IN ('poison', 'transient')),
  error_message text NOT NULL,
  error_stack text NULL,
  state text NOT NULL CHECK (state IN ('blocked', 'retrying', 'resolved', 'ignored')),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  resolved_at timestamptz NULL,
  PRIMARY KEY (projection_key, event_id)
);

CREATE INDEX IF NOT EXISTS event_projection_poison_events_active_idx
  ON event_projection_poison_events (projection_key, state, global_position)
  WHERE state IN ('blocked', 'retrying');

CREATE TABLE IF NOT EXISTS event_projection_blocked_streams (
  projection_key text NOT NULL,
  stream_id text NOT NULL,
  first_blocked_global_position bigint NOT NULL CHECK (first_blocked_global_position >= 0),
  first_blocked_stream_version bigint NOT NULL CHECK (first_blocked_stream_version > 0),
  last_seen_global_position bigint NOT NULL CHECK (last_seen_global_position >= 0),
  deferred_event_count integer NOT NULL DEFAULT 0 CHECK (deferred_event_count >= 0),
  state text NOT NULL CHECK (state IN ('blocked', 'retrying', 'resolved')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (projection_key, stream_id)
);

CREATE INDEX IF NOT EXISTS event_projection_blocked_streams_active_idx
  ON event_projection_blocked_streams (projection_key, state, first_blocked_global_position)
  WHERE state IN ('blocked', 'retrying');

-- Ledgered migrations: one-time reshapes below are removed from additive boot SQL
-- and applied once by infrastructure/bounded-context-runtime/schema.ts.

-- 20260710_event_store_write_hot_fillfactor
SET lock_timeout = '5s';

ALTER TABLE event_store_streams
  SET (fillfactor = 90);

ALTER TABLE event_projection_checkpoints
  SET (fillfactor = 90);


CREATE TABLE IF NOT EXISTS realtime_projection_outbox (
  outbox_id bigserial PRIMARY KEY,
  source_global_position bigint NOT NULL CHECK (source_global_position >= 0),
  projection_name text NOT NULL,
  patch_key text NOT NULL,
  topics jsonb NOT NULL,
  payload_json text NOT NULL,
  payload_kind text NOT NULL,
  payload_context text NOT NULL,
  payload_projection text NOT NULL,
  payload_bytes integer NOT NULL CHECK (payload_bytes >= 0),
  recorded_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT realtime_projection_outbox_source_patch_uk UNIQUE (
    projection_name,
    source_global_position,
    patch_key
  )
);

ALTER TABLE realtime_projection_outbox
  ADD COLUMN IF NOT EXISTS payload_json text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'realtime_projection_outbox'
      AND column_name = 'payload'
  ) THEN
    EXECUTE 'UPDATE realtime_projection_outbox SET payload_json = payload::text WHERE payload_json IS NULL';
  END IF;
END $$;

ALTER TABLE realtime_projection_outbox
  ADD COLUMN IF NOT EXISTS payload_kind text;

ALTER TABLE realtime_projection_outbox
  ADD COLUMN IF NOT EXISTS payload_context text;

ALTER TABLE realtime_projection_outbox
  ADD COLUMN IF NOT EXISTS payload_projection text;

ALTER TABLE realtime_projection_outbox
  ADD COLUMN IF NOT EXISTS payload_bytes integer CHECK (payload_bytes >= 0);

UPDATE realtime_projection_outbox
SET payload_json = '{}'::jsonb::text
WHERE payload_json IS NULL;

UPDATE realtime_projection_outbox
SET payload_kind = COALESCE(payload_json::jsonb ->> 'kind', 'projection.patch')
WHERE payload_kind IS NULL;

UPDATE realtime_projection_outbox
SET payload_context = COALESCE(payload_json::jsonb ->> 'context', '')
WHERE payload_context IS NULL;

UPDATE realtime_projection_outbox
SET payload_projection = COALESCE(payload_json::jsonb ->> 'projection', projection_name)
WHERE payload_projection IS NULL;

UPDATE realtime_projection_outbox
SET payload_bytes = octet_length(payload_json)
WHERE payload_bytes IS NULL;

ALTER TABLE realtime_projection_outbox
  ALTER COLUMN payload_json SET NOT NULL;

ALTER TABLE realtime_projection_outbox
  ALTER COLUMN payload_kind SET NOT NULL;

ALTER TABLE realtime_projection_outbox
  ALTER COLUMN payload_context SET NOT NULL;

ALTER TABLE realtime_projection_outbox
  ALTER COLUMN payload_projection SET NOT NULL;

ALTER TABLE realtime_projection_outbox
  ALTER COLUMN payload_bytes SET NOT NULL;

ALTER TABLE realtime_projection_outbox
  DROP COLUMN IF EXISTS payload;

CREATE INDEX IF NOT EXISTS realtime_projection_outbox_expires_idx
  ON realtime_projection_outbox (expires_at);

CREATE INDEX IF NOT EXISTS realtime_projection_outbox_outbox_idx
  ON realtime_projection_outbox (outbox_id ASC);

CREATE INDEX IF NOT EXISTS realtime_projection_outbox_payload_contract_idx
  ON realtime_projection_outbox (payload_context, payload_projection, payload_kind);

CREATE TABLE IF NOT EXISTS realtime_projection_outbox_topics (
  topic text NOT NULL,
  outbox_id bigint NOT NULL REFERENCES realtime_projection_outbox (outbox_id) ON DELETE CASCADE,
  PRIMARY KEY (topic, outbox_id)
);

CREATE INDEX IF NOT EXISTS realtime_projection_outbox_topics_outbox_idx
  ON realtime_projection_outbox_topics (outbox_id);

CREATE TABLE IF NOT EXISTS realtime_projection_topic_heads (
  topic text PRIMARY KEY,
  outbox_id bigint NOT NULL REFERENCES realtime_projection_outbox (outbox_id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS realtime_projection_outbox_retention (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  pruned_through_outbox_id bigint NOT NULL DEFAULT 0 CHECK (pruned_through_outbox_id >= 0),
  updated_at timestamptz NOT NULL
);


CREATE TABLE IF NOT EXISTS platform_policy_documents (
  document_id text PRIMARY KEY,
  policy_key text NOT NULL,
  context_name text NOT NULL,
  schema_summary text NOT NULL,
  status text NOT NULL,
  value jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_policy_documents_policy_key_idx
  ON platform_policy_documents (policy_key, effective_from DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_policy_document_history (
  history_id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  document_id text NOT NULL,
  policy_key text NOT NULL,
  event_type text NOT NULL,
  actor_user_id text NOT NULL,
  status text NOT NULL,
  value jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NULL,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_policy_document_history_document_idx
  ON platform_policy_document_history (document_id, recorded_at DESC, history_id DESC);



CREATE TABLE IF NOT EXISTS pricing_catalog_item_inputs (
  catalog_item_id text PRIMARY KEY,
  language_code text NOT NULL DEFAULT 'en',
  title text NOT NULL,
  subtitle text NULL,
  status text NOT NULL,
  category_ids text[] NOT NULL DEFAULT '{}',
  slug text NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE pricing_catalog_item_inputs
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en';

ALTER TABLE pricing_catalog_item_inputs
  ADD COLUMN IF NOT EXISTS category_ids text[] NOT NULL DEFAULT '{}';
-- Public market pages address catalog items by slug. Minted locally
-- (see ../../../../support/runtime-support/slugs.ts) from title/subtitle/id
-- already carried on the events this projection already consumes -- no new
-- event subscription needed, just a subscriptionVersion bump so replay
-- backfills the column for every pre-existing row.
ALTER TABLE pricing_catalog_item_inputs
  ADD COLUMN IF NOT EXISTS slug text NULL;

CREATE TABLE IF NOT EXISTS pricing_inventory_item_inputs (
  item_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  total_quantity integer NOT NULL CHECK (total_quantity >= 0),
  acquisition_cost_amount numeric(12, 2) NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL CHECK (last_stream_version >= 1)
);

ALTER TABLE pricing_inventory_item_inputs
  ADD COLUMN IF NOT EXISTS acquisition_cost_amount numeric(12, 2) NULL;

CREATE TABLE IF NOT EXISTS pricing_inventory_hold_inputs (
  hold_id text PRIMARY KEY,
  item_id text NOT NULL,
  seller_account_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 0),
  status text NOT NULL,
  released_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL CHECK (last_stream_version >= 1)
);

CREATE INDEX IF NOT EXISTS pricing_inventory_item_inputs_lookup_idx
  ON pricing_inventory_item_inputs (seller_account_id, catalog_catalog_item_id, product_id);

CREATE INDEX IF NOT EXISTS pricing_inventory_hold_inputs_item_idx
  ON pricing_inventory_hold_inputs (item_id, status);

CREATE TABLE IF NOT EXISTS pricing_market_listing_inputs (
  listing_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  inventory_item_id text NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  price_amount numeric(12, 2) NOT NULL,
  quantity_cap integer NOT NULL CHECK (quantity_cap >= 0),
  status text NOT NULL,
  grading text NULL CHECK (grading IS NULL OR grading IN ('graded', 'raw')),
  created_at timestamptz NULL,
  pause_reason text NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL DEFAULT 0 CHECK (last_stream_version >= 0)
);

CREATE INDEX IF NOT EXISTS pricing_market_listing_inputs_lookup_idx
  ON pricing_market_listing_inputs (seller_account_id, catalog_catalog_item_id, product_id, status);

ALTER TABLE pricing_market_listing_inputs
  ADD COLUMN IF NOT EXISTS inventory_item_id text NULL;

ALTER TABLE pricing_market_listing_inputs
  ADD COLUMN IF NOT EXISTS grading text NULL
  CHECK (grading IS NULL OR grading IN ('graded', 'raw'));

ALTER TABLE pricing_market_listing_inputs
  ADD COLUMN IF NOT EXISTS created_at timestamptz NULL;

ALTER TABLE pricing_market_listing_inputs
  ADD COLUMN IF NOT EXISTS pause_reason text NULL;

-- Stale-input guard: the listing handlers only advance a row when the event
-- carries a newer stream version, so a redelivered old price/lifecycle event
-- can never regress a newer competitor price. Backfilled lock-safely with a
-- constant 0 default (0 = pre-versioned baseline that the next real event,
-- always version >= 1, supersedes).
ALTER TABLE pricing_market_listing_inputs
  ADD COLUMN IF NOT EXISTS last_stream_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS pricing_buyer_offer_inputs (
  offer_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  seller_account_id text NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  price_amount numeric(12, 2) NOT NULL,
  quantity_requested integer NOT NULL CHECK (quantity_requested > 0),
  status text NOT NULL,
  accepted_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL DEFAULT 0 CHECK (last_stream_version >= 0)
);

CREATE INDEX IF NOT EXISTS pricing_buyer_offer_inputs_lookup_idx
  ON pricing_buyer_offer_inputs (catalog_catalog_item_id, product_id, status);

-- Stale-input guard: submitted/accepted upserts only advance a row when the
-- offer-stream version is newer, so a redelivered submitted can never clobber
-- an accepted price. Backfilled lock-safely with a constant 0 default.
ALTER TABLE pricing_buyer_offer_inputs
  ADD COLUMN IF NOT EXISTS last_stream_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS pricing_order_signal_lines (
  order_id text NOT NULL,
  line_id text NOT NULL,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  unit_price_amount numeric(12, 2) NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL,
  ready_for_fulfillment_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (order_id, line_id)
);

CREATE INDEX IF NOT EXISTS pricing_order_signal_lines_lookup_idx
  ON pricing_order_signal_lines (seller_account_id, catalog_catalog_item_id, product_id, status);

CREATE TABLE IF NOT EXISTS pricing_fulfillment_signal_lines (
  shipment_id text NOT NULL,
  line_id text NOT NULL,
  order_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL,
  delivered_at timestamptz NULL,
  returned_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (shipment_id, line_id)
);

CREATE INDEX IF NOT EXISTS pricing_fulfillment_signal_lines_lookup_idx
  ON pricing_fulfillment_signal_lines (catalog_catalog_item_id, product_id, status);



CREATE TABLE IF NOT EXISTS pricing_external_product_reference_inputs (
  provider_key text NOT NULL,
  external_key text NOT NULL,
  catalog_item_id text NOT NULL,
  catalog_product_key text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (provider_key, external_key)
);

CREATE INDEX IF NOT EXISTS pricing_external_product_reference_inputs_catalog_idx
  ON pricing_external_product_reference_inputs (catalog_item_id, catalog_product_key);

CREATE TABLE IF NOT EXISTS pricing_tcgplayer_price_signals (
  signal_id text PRIMARY KEY,
  external_key text NOT NULL,
  catalog_item_id text NOT NULL,
  catalog_product_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('current', 'stale', 'missing-price')),
  market_price_amount numeric(12, 2) NULL,
  lowest_price_amount numeric(12, 2) NULL,
  highest_price_amount numeric(12, 2) NULL,
  price_count integer NULL CHECK (price_count IS NULL OR price_count >= 0),
  calculated_at timestamptz NULL,
  observed_at timestamptz NOT NULL,
  stale_after timestamptz NOT NULL,
  source_payload jsonb NOT NULL,
  recommendation_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_tcgplayer_price_signals_product_idx
  ON pricing_tcgplayer_price_signals (catalog_item_id, catalog_product_key, observed_at DESC);

CREATE INDEX IF NOT EXISTS pricing_tcgplayer_price_signals_external_idx
  ON pricing_tcgplayer_price_signals (external_key, observed_at DESC);



CREATE TABLE IF NOT EXISTS pricing_external_catalog_item_reference_inputs (
  provider_key text NOT NULL,
  external_key text NOT NULL,
  catalog_item_id text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (provider_key, external_key)
);

CREATE INDEX IF NOT EXISTS pricing_external_catalog_item_reference_inputs_catalog_idx
  ON pricing_external_catalog_item_reference_inputs (catalog_item_id, external_key);

CREATE TABLE IF NOT EXISTS pricing_external_market_capture_cursors (
  provider_key text PRIMARY KEY,
  after_external_key text NOT NULL DEFAULT '',
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS pricing_external_market_captures (
  capture_id text PRIMARY KEY,
  provider_key text NOT NULL,
  catalog_item_id text NOT NULL,
  external_key text NOT NULL,
  signal_pass_started_at timestamptz NOT NULL,
  signal_policy_revision_id text NOT NULL,
  products_per_pass integer NOT NULL CHECK (products_per_pass BETWEEN 1 AND 5),
  capture_started_at timestamptz NOT NULL,
  capture_completed_at timestamptz NOT NULL,
  observation_policy_revision_id text NULL,
  stat_hygiene_policy_revision_id text NULL,
  captures_per_pass integer NULL CHECK (captures_per_pass IS NULL OR captures_per_pass BETWEEN 1 AND 5),
  currency text NULL CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$'),
  authenticated_request boolean NOT NULL,
  recorded_signal_count integer NOT NULL CHECK (recorded_signal_count >= 0),
  unresolved_signal_count integer NOT NULL CHECK (unresolved_signal_count >= 0),
  outcome_kind text NOT NULL CHECK (outcome_kind IN ('recorded','recorded-with-rejections','no-secondary-observations','mapping-unresolved','provider-unavailable','configuration-invalid','disabled')),
  reason_code text NULL CHECK (reason_code IS NULL OR reason_code IN ('observation-policy-invalid','stat-hygiene-policy-invalid','transport-not-mounted')),
  rejected_row_count integer NOT NULL CHECK (rejected_row_count >= 0),
  sales_status text NULL CHECK (sales_status IS NULL OR sales_status IN ('observed','unavailable','disabled','not-requested')),
  sales_requested_at timestamptz NULL,
  sales_response_observed_at timestamptz NULL,
  sales_coverage text NULL CHECK (sales_coverage IS NULL OR sales_coverage IN ('complete','request-cap-truncated','page-budget-truncated','inconsistent','unknown')),
  sales_pages_fetched integer NOT NULL DEFAULT 0 CHECK (sales_pages_fetched >= 0),
  sales_returned_count integer NOT NULL DEFAULT 0 CHECK (sales_returned_count >= 0),
  sales_first_reported_total integer NULL CHECK (sales_first_reported_total IS NULL OR sales_first_reported_total >= 0),
  sales_last_reported_total integer NULL CHECK (sales_last_reported_total IS NULL OR sales_last_reported_total >= 0),
  sales_last_next_page text NULL CHECK (sales_last_next_page IS NULL OR sales_last_next_page IN ('Yes','')),
  listings_status text NULL CHECK (listings_status IS NULL OR listings_status IN ('observed','unavailable','disabled','not-requested')),
  listings_requested_at timestamptz NULL,
  listings_response_observed_at timestamptz NULL,
  listings_coverage text NULL CHECK (listings_coverage IS NULL OR listings_coverage IN ('complete','ceiling-truncated','page-budget-truncated','inconsistent','unknown')),
  listings_pages_fetched integer NOT NULL DEFAULT 0 CHECK (listings_pages_fetched >= 0),
  listings_returned_count integer NOT NULL DEFAULT 0 CHECK (listings_returned_count >= 0),
  listings_reported_total integer NULL CHECK (listings_reported_total IS NULL OR listings_reported_total >= 0),
  own_seller_exclusion_applied boolean NOT NULL DEFAULT false,
  history_status text NULL CHECK (history_status IS NULL OR history_status IN ('observed','unavailable','disabled','not-requested')),
  history_requested_at timestamptz NULL,
  history_response_observed_at timestamptz NULL,
  history_coverage text NULL CHECK (history_coverage IS NULL OR history_coverage IN ('observed','inconsistent','unknown')),
  history_result_count integer NOT NULL DEFAULT 0 CHECK (history_result_count >= 0),
  history_bucket_count integer NOT NULL DEFAULT 0 CHECK (history_bucket_count >= 0),
  request_posture jsonb NULL,
  sales_first_result_count integer NULL CHECK (sales_first_result_count IS NULL OR sales_first_result_count >= 0),
  sales_last_result_count integer NULL CHECK (sales_last_result_count IS NULL OR sales_last_result_count >= 0),
  sales_http_status_class text NULL CHECK (sales_http_status_class IS NULL OR sales_http_status_class IN ('none','4xx','5xx','other')),
  listings_http_status_class text NULL CHECK (listings_http_status_class IS NULL OR listings_http_status_class IN ('none','4xx','5xx','other')),
  history_http_status_class text NULL CHECK (history_http_status_class IS NULL OR history_http_status_class IN ('none','4xx','5xx','other')),
  history_range text NULL CHECK (history_range IS NULL OR history_range = 'annual')
);

CREATE INDEX IF NOT EXISTS pricing_external_market_captures_lookup_idx
  ON pricing_external_market_captures (provider_key, catalog_item_id, capture_started_at DESC, capture_id DESC);

CREATE TABLE IF NOT EXISTS pricing_external_sale_observations (
  capture_id text NOT NULL REFERENCES pricing_external_market_captures(capture_id),
  sale_fingerprint text NOT NULL,
  observed_occurrence_count integer NOT NULL CHECK (observed_occurrence_count > 0),
  provider_condition text NOT NULL,
  provider_variant text NOT NULL,
  provider_language text NOT NULL,
  listing_type text NOT NULL,
  sold_at timestamptz NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  order_shipping numeric(12,2) NOT NULL CHECK (order_shipping >= 0),
  PRIMARY KEY (capture_id, sale_fingerprint)
);

CREATE INDEX IF NOT EXISTS pricing_external_sale_observations_sold_idx
  ON pricing_external_sale_observations (sold_at, capture_id);

CREATE TABLE IF NOT EXISTS pricing_external_weekly_sale_buckets (
  provider_key text NOT NULL,
  external_key text NOT NULL,
  catalog_item_id text NOT NULL,
  catalog_product_key text NULL,
  week_start date NOT NULL,
  provider_condition text NOT NULL,
  provider_variant text NOT NULL,
  provider_language text NOT NULL,
  transaction_count integer NOT NULL CHECK (transaction_count > 0),
  quantity_sold integer NOT NULL CHECK (quantity_sold >= 0),
  low_sale_amount numeric(12,2) NULL,
  high_sale_amount numeric(12,2) NULL,
  low_delivered_amount numeric(12,2) NULL,
  high_delivered_amount numeric(12,2) NULL,
  provider_market_amount numeric(12,2) NULL,
  last_capture_id text NOT NULL REFERENCES pricing_external_market_captures(capture_id),
  last_observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (provider_key, external_key, week_start)
);

CREATE INDEX IF NOT EXISTS pricing_external_weekly_sale_buckets_catalog_idx
  ON pricing_external_weekly_sale_buckets (provider_key, catalog_item_id, week_start, external_key);

CREATE TABLE IF NOT EXISTS pricing_external_listing_snapshots (
  provider_key text NOT NULL,
  catalog_item_id text NOT NULL,
  provider_variant text NOT NULL,
  provider_language text NOT NULL,
  provider_condition text NOT NULL,
  observed_on date NOT NULL,
  distinct_seller_count integer NOT NULL CHECK (distinct_seller_count >= 0),
  cheapest_delivered_amount numeric(12,2) NULL,
  second_cheapest_delivered_amount numeric(12,2) NULL,
  last_capture_id text NOT NULL REFERENCES pricing_external_market_captures(capture_id),
  last_observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (provider_key, catalog_item_id, provider_variant, provider_language, provider_condition, observed_on)
);

CREATE TABLE IF NOT EXISTS pricing_external_listing_ask_depth (
  capture_id text NOT NULL REFERENCES pricing_external_market_captures(capture_id),
  anonymous_capture_seller_ordinal integer NOT NULL CHECK (anonymous_capture_seller_ordinal > 0),
  provider_condition text NOT NULL,
  delivered_amount numeric(12,2) NOT NULL CHECK (delivered_amount >= 0),
  coverage text NOT NULL CHECK (coverage IN ('complete','ceiling-truncated','page-budget-truncated','inconsistent','unknown')),
  PRIMARY KEY (capture_id, anonymous_capture_seller_ordinal, provider_condition, delivered_amount)
);

CREATE INDEX IF NOT EXISTS pricing_external_listing_ask_depth_price_idx
  ON pricing_external_listing_ask_depth (capture_id, delivered_amount, provider_condition);



CREATE TABLE IF NOT EXISTS pricing_recommendation_pages (
  recommendation_id text PRIMARY KEY,
  catalog_catalog_item_id text NOT NULL,
  seller_account_id text NOT NULL,
  action_type text NOT NULL DEFAULT 'active-listing-price-update',
  status text NOT NULL DEFAULT 'proposed',
  listing_id text NULL,
  inventory_item_id text NULL,
  market_price_amount numeric(12, 2) NOT NULL,
  market_currency text NOT NULL,
  market_signal_type text NOT NULL DEFAULT 'competition',
  market_observed_at timestamptz NOT NULL,
  current_price_amount numeric(12, 2) NULL,
  recommended_list_amount numeric(12, 2) NULL,
  recommendation_reason text NULL,
  quantity_cap integer NULL,
  applied_listing_id text NULL,
  last_error text NULL,
  recommendation_published_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_recommendation_pages_seller_idx
  ON pricing_recommendation_pages (seller_account_id, updated_at DESC, recommendation_id DESC);

ALTER TABLE pricing_recommendation_pages
  ADD COLUMN IF NOT EXISTS action_type text NOT NULL DEFAULT 'active-listing-price-update',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'proposed',
  ADD COLUMN IF NOT EXISTS listing_id text NULL,
  ADD COLUMN IF NOT EXISTS inventory_item_id text NULL,
  ADD COLUMN IF NOT EXISTS market_signal_type text NOT NULL DEFAULT 'competition',
  ADD COLUMN IF NOT EXISTS current_price_amount numeric(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS quantity_cap integer NULL,
  ADD COLUMN IF NOT EXISTS applied_listing_id text NULL,
  ADD COLUMN IF NOT EXISTS last_error text NULL;

CREATE INDEX IF NOT EXISTS pricing_recommendation_pages_action_idx
  ON pricing_recommendation_pages (seller_account_id, status, action_type, updated_at DESC);

CREATE OR REPLACE VIEW pricing_recommendation_feed AS
SELECT
  recommendation.recommendation_id,
  recommendation.catalog_catalog_item_id,
  recommendation.seller_account_id,
  recommendation.action_type,
  recommendation.status,
  recommendation.listing_id,
  recommendation.inventory_item_id,
  catalog_input.language_code AS catalog_item_language_code,
  catalog_input.title AS catalog_item_title,
  catalog_input.subtitle AS catalog_item_subtitle,
  catalog_input.status AS catalog_item_status,
  recommendation.market_price_amount,
  recommendation.market_currency,
  recommendation.market_signal_type,
  recommendation.market_observed_at,
  recommendation.current_price_amount,
  recommendation.recommended_list_amount,
  recommendation.recommendation_reason,
  recommendation.quantity_cap,
  recommendation.applied_listing_id,
  recommendation.last_error,
  recommendation.recommendation_published_at,
  COALESCE(stock_signal.stock_on_hand_quantity, 0) AS stock_on_hand_quantity,
  COALESCE(stock_signal.stock_reserved_quantity, 0) AS stock_reserved_quantity,
  COALESCE(market_signal.active_listing_count, 0) AS active_listing_count,
  market_signal.lowest_listing_price_amount,
  COALESCE(market_signal.active_offer_count, 0) AS active_offer_count,
  market_signal.highest_offer_price_amount,
  COALESCE(order_signal.committed_order_quantity, 0) AS committed_order_quantity,
  COALESCE(fulfillment_signal.delivered_quantity, 0) AS delivered_quantity,
  COALESCE(fulfillment_signal.returned_quantity, 0) AS returned_quantity,
  recommendation.updated_at
FROM pricing_recommendation_pages AS recommendation
LEFT JOIN pricing_catalog_item_inputs AS catalog_input
  ON catalog_input.catalog_item_id = recommendation.catalog_catalog_item_id
LEFT JOIN (
  SELECT
    item_input.seller_account_id,
    item_input.catalog_catalog_item_id,
    SUM(item_input.total_quantity)::integer AS stock_on_hand_quantity,
    COALESCE(
      SUM(
        CASE
          WHEN hold_input.status = 'active' THEN hold_input.quantity
          ELSE 0
        END
      ),
      0
    )::integer AS stock_reserved_quantity
  FROM pricing_inventory_item_inputs AS item_input
  LEFT JOIN pricing_inventory_hold_inputs AS hold_input
    ON hold_input.item_id = item_input.item_id
  GROUP BY item_input.seller_account_id, item_input.catalog_catalog_item_id
) AS stock_signal
  ON stock_signal.seller_account_id = recommendation.seller_account_id
 AND stock_signal.catalog_catalog_item_id = recommendation.catalog_catalog_item_id
LEFT JOIN (
  SELECT
    catalog_catalog_item_id,
    COUNT(*) FILTER (WHERE status = 'active')::integer AS active_listing_count,
    MIN(price_amount) FILTER (WHERE status = 'active') AS lowest_listing_price_amount,
    COUNT(*) FILTER (WHERE status = 'submitted')::integer AS active_offer_count,
    MAX(price_amount) FILTER (WHERE status = 'submitted') AS highest_offer_price_amount
  FROM (
    SELECT
      catalog_catalog_item_id,
      price_amount,
      status
    FROM pricing_market_listing_inputs
    UNION ALL
    SELECT
      catalog_catalog_item_id,
      price_amount,
      status
    FROM pricing_buyer_offer_inputs
  ) AS market_inputs
  GROUP BY catalog_catalog_item_id
) AS market_signal
  ON market_signal.catalog_catalog_item_id = recommendation.catalog_catalog_item_id
LEFT JOIN (
  SELECT
    seller_account_id,
    catalog_catalog_item_id,
    COALESCE(
      SUM(
        CASE
          WHEN status = 'ready-for-fulfillment' THEN quantity
          ELSE 0
        END
      ),
      0
    )::integer AS committed_order_quantity
  FROM pricing_order_signal_lines
  GROUP BY seller_account_id, catalog_catalog_item_id
) AS order_signal
  ON order_signal.seller_account_id = recommendation.seller_account_id
 AND order_signal.catalog_catalog_item_id = recommendation.catalog_catalog_item_id
LEFT JOIN (
  SELECT
    order_signal.seller_account_id,
    fulfillment_input.catalog_catalog_item_id,
    COALESCE(
      SUM(
        CASE
          WHEN fulfillment_input.status = 'delivered' THEN fulfillment_input.quantity
          ELSE 0
        END
      ),
      0
    )::integer AS delivered_quantity,
    COALESCE(
      SUM(
        CASE
          WHEN fulfillment_input.status = 'returned' THEN fulfillment_input.quantity
          ELSE 0
        END
      ),
      0
    )::integer AS returned_quantity
  FROM pricing_fulfillment_signal_lines AS fulfillment_input
  INNER JOIN pricing_order_signal_lines AS order_signal
    ON order_signal.order_id = fulfillment_input.order_id
  GROUP BY order_signal.seller_account_id, fulfillment_input.catalog_catalog_item_id
) AS fulfillment_signal
  ON fulfillment_signal.seller_account_id = recommendation.seller_account_id
 AND fulfillment_signal.catalog_catalog_item_id = recommendation.catalog_catalog_item_id;


CREATE TABLE IF NOT EXISTS pricing_recommendation_jobs (
  job_id text PRIMARY KEY,
  job_kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NULL,
  error_message text NULL,
  event_context jsonb NULL,
  claim_owner_id text NULL,
  claimed_until timestamptz NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  next_eligible_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL,
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE pricing_recommendation_jobs
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

ALTER TABLE pricing_recommendation_jobs
  ADD COLUMN IF NOT EXISTS next_eligible_at timestamptz NULL;

UPDATE pricing_recommendation_jobs
SET next_eligible_at = COALESCE(next_eligible_at, created_at, updated_at, now())
WHERE next_eligible_at IS NULL;

ALTER TABLE pricing_recommendation_jobs
  ALTER COLUMN next_eligible_at SET DEFAULT now(),
  ALTER COLUMN next_eligible_at SET NOT NULL;

DO $$
BEGIN
  ALTER TABLE pricing_recommendation_jobs
    ADD CONSTRAINT pricing_recommendation_jobs_attempt_count_nonnegative CHECK (attempt_count >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS pricing_recommendation_jobs_status_created_idx
  ON pricing_recommendation_jobs (status, created_at ASC);

CREATE INDEX IF NOT EXISTS pricing_recommendation_jobs_claim_eligibility_idx
  ON pricing_recommendation_jobs (status, next_eligible_at ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS pricing_recommendation_jobs_kind_status_idx
  ON pricing_recommendation_jobs (job_kind, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS pricing_recommendation_jobs_event_context_idx
  ON pricing_recommendation_jobs USING GIN (event_context);

CREATE INDEX IF NOT EXISTS pricing_recommendation_jobs_event_context_actor_idx
  ON pricing_recommendation_jobs (
    (event_context->>'tenantId'),
    (event_context->'audit'->>'forAccountId'),
    (event_context->'audit'->>'performedByUserId'),
    updated_at DESC
  );

CREATE TABLE IF NOT EXISTS pricing_recommendation_job_events (
  job_id text NOT NULL REFERENCES pricing_recommendation_jobs(job_id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 1),
  event_name text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (job_id, sequence)
);

CREATE INDEX IF NOT EXISTS pricing_recommendation_job_events_lookup_idx
  ON pricing_recommendation_job_events (job_id, sequence);



CREATE TABLE IF NOT EXISTS pricing_recommendation_work_units (
  job_id text NOT NULL REFERENCES pricing_recommendation_jobs(job_id) ON DELETE CASCADE,
  unit_id text NOT NULL,
  unit_kind text NOT NULL DEFAULT 'default',
  state text NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'skipped')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NULL,
  error_message text NULL,
  claim_owner_id text NULL,
  claim_token text NULL,
  claimed_until timestamptz NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  PRIMARY KEY (job_id, unit_id)
);

CREATE INDEX IF NOT EXISTS pricing_recommendation_work_units_claimable_idx
  ON pricing_recommendation_work_units (state, claimed_until, created_at ASC);

CREATE INDEX IF NOT EXISTS pricing_recommendation_work_units_job_state_idx
  ON pricing_recommendation_work_units (job_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS pricing_recommendation_work_units_active_claims_idx
  ON pricing_recommendation_work_units (job_id, claimed_until)
  WHERE state = 'running';




CREATE TABLE IF NOT EXISTS pricing_market_trades (
  order_id text NOT NULL,
  line_id text NOT NULL,
  seller_account_id text NOT NULL,
  buyer_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  unit_price_amount numeric(12, 2) NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  sale_channel text NOT NULL CHECK (sale_channel IN ('listing', 'offer-accepted', 'buy-now')),
  shipment_id text NULL,
  -- Payment capture (order.ready-for-fulfillment-recorded). NULL means the
  -- order line has not yet printed on the tape.
  sold_at timestamptz NULL,
  -- Delivery (fulfillment.shipment.delivered). NULL until the shipment
  -- carrying this line is marked delivered.
  settled_at timestamptz NULL,
  -- Set true by an m109 authenticity-case 'passed' verdict on the trade's
  -- order (see integrations/integrity/integrity-projection.ts).
  verified boolean NOT NULL DEFAULT false,
  -- 'fraud-flagged' is wired by m107 risk-flag events (identity
  -- manual-payout-review badge assignment, Stripe early-fraud-warning
  -- receipt). 'self-dealing' is pair-scoped proxy self-dealing: Pricing
  -- writes it only when Settlement has flagged a linkage cluster containing
  -- BOTH counterparties. Same-account orders remain hard-blocked upstream.
  excluded boolean NOT NULL DEFAULT false,
  exclusion_reason text NULL CHECK (exclusion_reason IN ('refunded', 'cancelled', 'fraud-flagged', 'self-dealing')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (order_id, line_id),
  CHECK (
    (excluded = false AND exclusion_reason IS NULL) OR
    (excluded = true AND exclusion_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS pricing_market_trades_time_series_idx
  ON pricing_market_trades (catalog_catalog_item_id, product_id, sold_at DESC);

CREATE INDEX IF NOT EXISTS pricing_market_trades_included_time_series_idx
  ON pricing_market_trades (catalog_catalog_item_id, product_id, sold_at DESC)
  WHERE excluded = false;

CREATE INDEX IF NOT EXISTS pricing_market_trades_shipment_idx
  ON pricing_market_trades (shipment_id)
  WHERE shipment_id IS NOT NULL;

-- Tape-integrity correlation seam: m109 authenticity verdicts carry only
-- caseId, not orderId/lineId, so this small side table remembers the
-- caseId -> orderId link recorded when the case opens (which does carry
-- orderId) for the verdict-recorded reaction to join back through. Owned by
-- the same pricing-market-trades-projection group as pricing_market_trades
-- itself -- it exists purely to serve that projection's own reactions, never
-- queried by another projection or route.
CREATE TABLE IF NOT EXISTS pricing_market_trade_authenticity_cases (
  case_id text PRIMARY KEY,
  order_id text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_market_trade_authenticity_cases_order_idx
  ON pricing_market_trade_authenticity_cases (order_id);

-- Pricing's local, replayable view of Settlement-owned linkage facts. Cleared
-- rows are retained so the flagged -> cleared lifecycle is inspectable and a
-- replay converges without consulting Settlement's private risk read model.
CREATE TABLE IF NOT EXISTS pricing_market_trade_linkage_clusters (
  cluster_hash text PRIMARY KEY,
  signal_kind text NOT NULL CHECK (signal_kind IN ('shared-instrument', 'shared-address')),
  account_ids text[] NOT NULL CHECK (cardinality(account_ids) >= 2),
  flagged boolean NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_market_trade_linkage_clusters_accounts_idx
  ON pricing_market_trade_linkage_clusters USING gin (account_ids)
  WHERE flagged = true;

-- Retroactive tape corrections can target days older than the closer's live
-- trailing window. Integrity reactions enqueue the distinct affected day
-- tuples here; the scheduled rollup closer drains them with a bounded batch.
CREATE TABLE IF NOT EXISTS pricing_market_trade_rollup_rederive_queue (
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  day date NOT NULL,
  queued_at timestamptz NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (catalog_catalog_item_id, product_id, day)
);

CREATE INDEX IF NOT EXISTS pricing_market_trade_rollup_rederive_queue_age_idx
  ON pricing_market_trade_rollup_rederive_queue (queued_at, catalog_catalog_item_id, product_id, day);



CREATE TABLE IF NOT EXISTS pricing_daily_product_rollups (
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  day date NOT NULL,
  first_price_amount numeric(12, 2) NULL,
  last_price_amount numeric(12, 2) NULL,
  min_price_amount numeric(12, 2) NULL,
  max_price_amount numeric(12, 2) NULL,
  median_price_amount numeric(12, 2) NULL,
  stat_hygiene_policy_revision_id text NOT NULL DEFAULT 'pricing.market-stat-hygiene/compiled-v1',
  unit_volume integer NOT NULL DEFAULT 0,
  trade_count integer NOT NULL DEFAULT 0,
  verified_trade_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_catalog_item_id, product_id, day)
);

CREATE INDEX IF NOT EXISTS pricing_daily_product_rollups_series_idx
  ON pricing_daily_product_rollups (catalog_catalog_item_id, product_id, day DESC);

CREATE TABLE IF NOT EXISTS pricing_market_state_snapshots (
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  day date NOT NULL,
  active_listing_count integer NOT NULL DEFAULT 0,
  min_ask_amount numeric(12, 2) NULL,
  open_offer_count integer NOT NULL DEFAULT 0,
  max_bid_amount numeric(12, 2) NULL,
  spread_amount numeric(12, 2) NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_catalog_item_id, product_id, day)
);

CREATE INDEX IF NOT EXISTS pricing_market_state_snapshots_series_idx
  ON pricing_market_state_snapshots (catalog_catalog_item_id, product_id, day DESC);

CREATE TABLE IF NOT EXISTS pricing_product_market_aggregates (
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  last_sold_at timestamptz NULL,
  last_sold_price_amount numeric(12, 2) NULL,
  median_price_30d numeric(12, 2) NULL,
  volume_30d integer NOT NULL DEFAULT 0,
  trade_count_30d integer NOT NULL DEFAULT 0,
  median_price_90d numeric(12, 2) NULL,
  volume_90d integer NOT NULL DEFAULT 0,
  trade_count_90d integer NOT NULL DEFAULT 0,
  sell_through_rate numeric(6, 4) NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_catalog_item_id, product_id)
);

/**
 * Platform Daily Rollup: the platform-wide sibling of the daily
 * PRODUCT rollup above -- one row per calendar day, summed across every
 * product, instead of one row per (product, day). Only additive fields
 * live here (GMV amount, trade/order/unit counts): additive columns can be
 * safely re-summed across a wider date_trunc bucket at query time (see
 * platform-queries.ts) without a double-counting risk. Distinct-count KPIs
 * (active buyer/seller counts) are NOT stored here, deliberately -- summing
 * daily distinct-account counts across a week/month would double-count a
 * buyer or seller active on more than one day in the window. Those are
 * computed directly off the Trades Tape for the exact requested range
 * instead (getPlatformKpiSummary in platform-queries.ts).
 *
 * Maintained by the same recompute-safe daily closer job as the per-product
 * rollup (see rollup-maintenance.ts); same retention-forever, same
 * excluded-trade omission convention.
 */
CREATE TABLE IF NOT EXISTS pricing_platform_daily_rollups (
  day date PRIMARY KEY,
  gmv_amount numeric(14, 2) NOT NULL DEFAULT 0,
  trade_count integer NOT NULL DEFAULT 0,
  unit_volume integer NOT NULL DEFAULT 0,
  order_count integer NOT NULL DEFAULT 0,
  verified_trade_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL
);



CREATE TABLE IF NOT EXISTS pricing_market_price_estimates (
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  estimate_version bigint NOT NULL,
  window_started_at timestamptz NOT NULL,
  window_ended_at timestamptz NOT NULL,
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  band_low_amount numeric(12, 2) NULL,
  band_high_amount numeric(12, 2) NULL,
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  platform_verified_trade_count integer NOT NULL DEFAULT 0,
  platform_trade_count integer NOT NULL DEFAULT 0,
  external_comp_count integer NOT NULL DEFAULT 0,
  previous_amount numeric(12, 2) NULL,
  estimated_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL,
  disclosure text NOT NULL CHECK (disclosure IN ('internal', 'account', 'public')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_catalog_item_id, product_id)
);

CREATE INDEX IF NOT EXISTS pricing_market_price_estimates_freshness_idx
  ON pricing_market_price_estimates (fresh_until);

-- Where the estimate closer pass stopped in the (catalog item, product)
-- candidate keyspace, so successive passes cover EVERY eligible product
-- instead of revisiting the same first page (see queries.ts
-- listMarketEstimateCandidateTuples). One row per closer; absent row means
-- the next pass starts from the beginning.
CREATE TABLE IF NOT EXISTS pricing_market_estimate_closer_cursors (
  closer_name text PRIMARY KEY,
  after_catalog_item_id text NOT NULL,
  after_product_id text NOT NULL,
  updated_at timestamptz NOT NULL
);



CREATE TABLE IF NOT EXISTS pricing_repricing_policies (
  policy_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  scope_kind text NOT NULL,
  scope_category_ids text[] NULL,
  scope_listing_ids text[] NULL,
  excluded_listing_ids text[] NOT NULL DEFAULT '{}',
  rules jsonb NOT NULL,
  max_changes_per_day integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_repricing_policies_account_idx
  ON pricing_repricing_policies (seller_account_id, status, updated_at DESC);

CREATE OR REPLACE VIEW pricing_repricing_policy_assignments AS
WITH candidate_matches AS (
  SELECT
    listing.seller_account_id,
    listing.listing_id,
    policy.policy_id,
    CASE policy.scope_kind
      WHEN 'listing-set' THEN 2
      WHEN 'catalog-filter' THEN 1
      ELSE 0
    END AS scope_specificity,
    policy.updated_at AS policy_updated_at
  FROM pricing_market_listing_inputs AS listing
  JOIN pricing_repricing_policies AS policy
    ON policy.seller_account_id = listing.seller_account_id
   AND policy.status = 'active'
  LEFT JOIN pricing_catalog_item_inputs AS catalog_item
    ON catalog_item.catalog_item_id = listing.catalog_catalog_item_id
  WHERE listing.status <> 'withdrawn'
    AND NOT (listing.listing_id = ANY (policy.excluded_listing_ids))
    AND (
      policy.scope_kind = 'all-listings'
      OR (
        policy.scope_kind = 'catalog-filter'
        AND catalog_item.category_ids IS NOT NULL
        AND catalog_item.category_ids && policy.scope_category_ids
      )
      OR (
        policy.scope_kind = 'listing-set'
        AND listing.listing_id = ANY (policy.scope_listing_ids)
      )
    )
),
ranked_matches AS (
  SELECT
    seller_account_id,
    listing_id,
    policy_id,
    scope_specificity,
    policy_updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY seller_account_id, listing_id
      ORDER BY scope_specificity DESC, policy_updated_at DESC, policy_id DESC
    ) AS precedence_rank
  FROM candidate_matches
)
SELECT
  seller_account_id,
  listing_id,
  policy_id,
  scope_specificity,
  policy_updated_at AS assigned_policy_updated_at
FROM ranked_matches
WHERE precedence_rank = 1;




CREATE TABLE IF NOT EXISTS pricing_repricing_evaluation_jobs (
  job_id text PRIMARY KEY,
  job_kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NULL,
  error_message text NULL,
  event_context jsonb NULL,
  claim_owner_id text NULL,
  claimed_until timestamptz NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  next_eligible_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL,
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE pricing_repricing_evaluation_jobs
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

ALTER TABLE pricing_repricing_evaluation_jobs
  ADD COLUMN IF NOT EXISTS next_eligible_at timestamptz NULL;

UPDATE pricing_repricing_evaluation_jobs
SET next_eligible_at = COALESCE(next_eligible_at, created_at, updated_at, now())
WHERE next_eligible_at IS NULL;

ALTER TABLE pricing_repricing_evaluation_jobs
  ALTER COLUMN next_eligible_at SET DEFAULT now(),
  ALTER COLUMN next_eligible_at SET NOT NULL;

DO $$
BEGIN
  ALTER TABLE pricing_repricing_evaluation_jobs
    ADD CONSTRAINT pricing_repricing_evaluation_jobs_attempt_count_nonnegative CHECK (attempt_count >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS pricing_repricing_evaluation_jobs_status_created_idx
  ON pricing_repricing_evaluation_jobs (status, created_at ASC);

CREATE INDEX IF NOT EXISTS pricing_repricing_evaluation_jobs_claim_eligibility_idx
  ON pricing_repricing_evaluation_jobs (status, next_eligible_at ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS pricing_repricing_evaluation_jobs_kind_status_idx
  ON pricing_repricing_evaluation_jobs (job_kind, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS pricing_repricing_evaluation_jobs_event_context_idx
  ON pricing_repricing_evaluation_jobs USING GIN (event_context);

CREATE INDEX IF NOT EXISTS pricing_repricing_evaluation_jobs_event_context_actor_idx
  ON pricing_repricing_evaluation_jobs (
    (event_context->>'tenantId'),
    (event_context->'audit'->>'forAccountId'),
    (event_context->'audit'->>'performedByUserId'),
    updated_at DESC
  );

CREATE TABLE IF NOT EXISTS pricing_repricing_evaluation_job_events (
  job_id text NOT NULL REFERENCES pricing_repricing_evaluation_jobs(job_id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 1),
  event_name text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (job_id, sequence)
);

CREATE INDEX IF NOT EXISTS pricing_repricing_evaluation_job_events_lookup_idx
  ON pricing_repricing_evaluation_job_events (job_id, sequence);


CREATE TABLE IF NOT EXISTS pricing_repricing_policy_evaluations (
  evaluation_id text PRIMARY KEY,
  policy_id text NOT NULL,
  policy_revision text NOT NULL,
  seller_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  trigger_kind text NOT NULL,
  trigger_event_id text NOT NULL,
  trigger_signal_version text NOT NULL,
  listings_evaluated integer NOT NULL,
  listings_changed integer NOT NULL,
  listings_skipped integer NOT NULL,
  listing_traces jsonb NOT NULL,
  signal_to_evaluation_latency_ms integer NOT NULL,
  evaluated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_repricing_policy_evaluations_policy_idx
  ON pricing_repricing_policy_evaluations (policy_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS pricing_repricing_policy_evaluations_product_idx
  ON pricing_repricing_policy_evaluations (catalog_catalog_item_id, product_id, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS pricing_repricing_daily_change_budgets (
  seller_account_id text NOT NULL,
  budget_day date NOT NULL,
  changes_reserved integer NOT NULL CHECK (changes_reserved >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (seller_account_id, budget_day)
);

CREATE TABLE IF NOT EXISTS pricing_repricing_product_round_cooldowns (
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  next_eligible_at timestamptz NOT NULL,
  last_trigger_event_id text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_catalog_item_id, product_id)
);

CREATE TABLE IF NOT EXISTS pricing_repricing_policy_listing_pauses (
  listing_id text PRIMARY KEY,
  policy_id text NOT NULL,
  paused_at timestamptz NOT NULL,
  input_available_since timestamptz NULL,
  resumed_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS pricing_repricing_daily_sweep_cursor (
  sweep_name text PRIMARY KEY,
  sweep_day date NOT NULL,
  after_catalog_item_id text NULL,
  after_product_id text NULL,
  completed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL
);



CREATE TABLE IF NOT EXISTS platform_policy_documents (
  document_id text PRIMARY KEY,
  policy_key text NOT NULL,
  context_name text NOT NULL,
  schema_summary text NOT NULL,
  status text NOT NULL,
  value jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_policy_documents_policy_key_idx
  ON platform_policy_documents (policy_key, effective_from DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_policy_document_history (
  history_id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  document_id text NOT NULL,
  policy_key text NOT NULL,
  event_type text NOT NULL,
  actor_user_id text NOT NULL,
  status text NOT NULL,
  value jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NULL,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_policy_document_history_document_idx
  ON platform_policy_document_history (document_id, recorded_at DESC, history_id DESC);



CREATE TABLE IF NOT EXISTS pricing_bulk_reprice_job_inputs (
  input_id text PRIMARY KEY,
  account_id text NOT NULL,
  rows jsonb NOT NULL,
  row_count integer NOT NULL,
  source_filename text NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_bulk_reprice_job_inputs_account_idx
  ON pricing_bulk_reprice_job_inputs (account_id, created_at DESC);


CREATE TABLE IF NOT EXISTS pricing_bulk_reprice_jobs (
  job_id text PRIMARY KEY,
  job_kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NULL,
  error_message text NULL,
  event_context jsonb NULL,
  claim_owner_id text NULL,
  claimed_until timestamptz NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  next_eligible_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL,
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE pricing_bulk_reprice_jobs
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

ALTER TABLE pricing_bulk_reprice_jobs
  ADD COLUMN IF NOT EXISTS next_eligible_at timestamptz NULL;

UPDATE pricing_bulk_reprice_jobs
SET next_eligible_at = COALESCE(next_eligible_at, created_at, updated_at, now())
WHERE next_eligible_at IS NULL;

ALTER TABLE pricing_bulk_reprice_jobs
  ALTER COLUMN next_eligible_at SET DEFAULT now(),
  ALTER COLUMN next_eligible_at SET NOT NULL;

DO $$
BEGIN
  ALTER TABLE pricing_bulk_reprice_jobs
    ADD CONSTRAINT pricing_bulk_reprice_jobs_attempt_count_nonnegative CHECK (attempt_count >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS pricing_bulk_reprice_jobs_status_created_idx
  ON pricing_bulk_reprice_jobs (status, created_at ASC);

CREATE INDEX IF NOT EXISTS pricing_bulk_reprice_jobs_claim_eligibility_idx
  ON pricing_bulk_reprice_jobs (status, next_eligible_at ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS pricing_bulk_reprice_jobs_kind_status_idx
  ON pricing_bulk_reprice_jobs (job_kind, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS pricing_bulk_reprice_jobs_event_context_idx
  ON pricing_bulk_reprice_jobs USING GIN (event_context);

CREATE INDEX IF NOT EXISTS pricing_bulk_reprice_jobs_event_context_actor_idx
  ON pricing_bulk_reprice_jobs (
    (event_context->>'tenantId'),
    (event_context->'audit'->>'forAccountId'),
    (event_context->'audit'->>'performedByUserId'),
    updated_at DESC
  );

CREATE TABLE IF NOT EXISTS pricing_bulk_reprice_job_events (
  job_id text NOT NULL REFERENCES pricing_bulk_reprice_jobs(job_id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 1),
  event_name text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (job_id, sequence)
);

CREATE INDEX IF NOT EXISTS pricing_bulk_reprice_job_events_lookup_idx
  ON pricing_bulk_reprice_job_events (job_id, sequence);


CREATE TABLE IF NOT EXISTS pricing_bulk_reprice_create_rate_limit_buckets (
  account_id text PRIMARY KEY,
  request_count integer NOT NULL CHECK (request_count >= 1),
  window_started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS pricing_bulk_reprice_rows (
  job_id text NOT NULL,
  row_number integer NOT NULL,
  seller_sku text NULL,
  listing_id text NULL,
  requested_price_amount numeric(12, 2) NULL,
  resolved_listing_id text NULL,
  previous_price_amount numeric(12, 2) NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'unchanged', 'failed')),
  error_message text NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (job_id, row_number)
);

CREATE INDEX IF NOT EXISTS pricing_bulk_reprice_rows_job_outcome_idx
  ON pricing_bulk_reprice_rows (job_id, outcome);
