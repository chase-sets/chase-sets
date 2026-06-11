export const discoveryProductAlertSchemaSql = `
CREATE TABLE IF NOT EXISTS discovery_product_alert_pages (
  alert_id text PRIMARY KEY,
  account_id text NOT NULL,
  market_side text NOT NULL CHECK (market_side IN ('listing', 'offer')),
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  threshold_amount numeric(12, 2) NULL,
  status text NOT NULL CHECK (status IN ('active', 'paused', 'deleted')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS discovery_product_alert_pages_account_idx
  ON discovery_product_alert_pages (account_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS discovery_product_alert_pages_match_idx
  ON discovery_product_alert_pages (market_side, product_id, status);

CREATE TABLE IF NOT EXISTS discovery_product_alert_market_activity (
  activity_id text PRIMARY KEY,
  market_side text NOT NULL CHECK (market_side IN ('listing', 'offer')),
  owner_account_id text NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  item_title text NULL,
  item_subtitle text NULL,
  product_summary text NULL,
  price_amount numeric(12, 2) NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 0),
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS discovery_product_alert_market_activity_match_idx
  ON discovery_product_alert_market_activity (market_side, product_id, status, price_amount);

CREATE TABLE IF NOT EXISTS discovery_product_alert_match_notifications (
  alert_id text NOT NULL,
  activity_id text NOT NULL,
  match_key text NOT NULL,
  source_global_position text NOT NULL,
  notified_at timestamptz NOT NULL,
  PRIMARY KEY (alert_id, activity_id, match_key)
);

CREATE TABLE IF NOT EXISTS discovery_anonymous_product_alert_intents (
  intent_id text PRIMARY KEY,
  anonymous_owner_id text NOT NULL,
  source_path text NOT NULL,
  market_side text NOT NULL CHECK (market_side IN ('listing', 'offer')),
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  threshold_amount numeric(12, 2) NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'claimed', 'expired')),
  claimed_account_id text NULL,
  claimed_alert_id text NULL,
  claimed_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_anonymous_product_alert_intents_owner_active_idx
  ON discovery_anonymous_product_alert_intents (anonymous_owner_id, status, expires_at);

CREATE INDEX IF NOT EXISTS discovery_anonymous_product_alert_intents_expiry_idx
  ON discovery_anonymous_product_alert_intents (status, expires_at);
`;
