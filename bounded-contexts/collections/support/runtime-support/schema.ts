import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { savedListValuationSchemaSql } from "../../features/saved-list-valuation/read-model/schema";
import { savedListReadModelSchemaSql } from "../../features/saved-lists/read-model/schema";
import { savedListSharedPageSchemaSql } from "../../features/saved-lists/read-model/shared-page-schema";

const savedListDiscoverySchemaSql = `CREATE TABLE IF NOT EXISTS collections_saved_list_picker (
  list_id text PRIMARY KEY,
  owner_account_id text NOT NULL,
  title text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('active', 'archived')),
  line_count integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  tracked_unit_count integer NOT NULL DEFAULT 0 CHECK (tracked_unit_count >= 0),
  line_quantities jsonb NOT NULL DEFAULT '{}'::jsonb,
  list_version integer NOT NULL CHECK (list_version >= 1),
  created_at timestamptz NOT NULL,
  changed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS collections_saved_list_picker_owner_recent_idx
  ON collections_saved_list_picker (owner_account_id, lifecycle, changed_at DESC, list_id DESC);

CREATE TABLE IF NOT EXISTS collections_anonymous_saved_list_intents (
  intent_id text PRIMARY KEY,
  anonymous_owner_id text NOT NULL,
  source_path text NOT NULL,
  source_surface text NOT NULL CHECK (source_surface IN ('search', 'item-detail')),
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  add_command_id text NOT NULL,
  line_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'claiming', 'claimed', 'expired')),
  claimed_account_id text NULL,
  claimed_list_id text NULL,
  claimed_create_command_id text NULL,
  claimed_list_title text NULL,
  claimed_tracked_quantity integer NULL CHECK (claimed_tracked_quantity IS NULL OR claimed_tracked_quantity > 0),
  claimed_expected_version integer NULL CHECK (claimed_expected_version IS NULL OR claimed_expected_version >= 1),
  claimed_response jsonb NULL,
  claimed_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collections_anonymous_saved_list_intents_owner_active_idx
  ON collections_anonymous_saved_list_intents (anonymous_owner_id, status, expires_at);

CREATE INDEX IF NOT EXISTS collections_anonymous_saved_list_intents_expiry_idx
  ON collections_anonymous_saved_list_intents (status, expires_at);`;

export const collectionsSchemaSql = [
  eventCorePostgresSchemaSql,
  savedListValuationSchemaSql,
  savedListReadModelSchemaSql,
  savedListSharedPageSchemaSql,
  savedListDiscoverySchemaSql,
].join("\n\n");
