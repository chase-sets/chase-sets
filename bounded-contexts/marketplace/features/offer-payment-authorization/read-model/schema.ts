import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const offerPaymentAuthorizationSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_buyer_payment_instrument_snapshots (
  account_id text PRIMARY KEY,
  published_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL
);
CREATE TABLE IF NOT EXISTS marketplace_buyer_payment_instruments (
  account_id text NOT NULL REFERENCES marketplace_buyer_payment_instrument_snapshots(account_id),
  instrument_id text NOT NULL,
  category text NOT NULL,
  readiness text NOT NULL,
  checkout_eligible boolean NOT NULL,
  display_label text NOT NULL,
  removed_at timestamptz,
  PRIMARY KEY (account_id, instrument_id)
);
CREATE TABLE IF NOT EXISTS marketplace_offer_payment_authorizations (
  account_id text PRIMARY KEY,
  state text NOT NULL,
  generation integer NOT NULL,
  use_balance boolean NOT NULL,
  instrument_id text,
  instrument_category text,
  consent_version text,
  latest_held_order_id text,
  stream_version integer NOT NULL
);`;

export const offerPaymentAuthorizationMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261123_marketplace_offer_payment_authorization",
    description: "Install the private buyer authorization and payment instrument read models.",
    statements: [offerPaymentAuthorizationSchemaSql],
  },
];
