import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const table = `CREATE TABLE IF NOT EXISTS channels_ebay_account_deletion_receipts (
  notification_id text PRIMARY KEY CHECK (octet_length(notification_id) BETWEEN 1 AND 1024),
  topic text NOT NULL CHECK (topic = 'MARKETPLACE_ACCOUNT_DELETION'),
  event_date text NOT NULL,
  publish_date text NOT NULL,
  publish_attempt_count bigint NOT NULL CHECK (publish_attempt_count BETWEEN 1 AND 9007199254740991),
  subject_key_id text NOT NULL CHECK (subject_key_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  subject_fingerprint text NOT NULL CHECK (subject_fingerprint ~ '^v1:ebay-subject-root-v1:[a-f0-9]{64}$'),
  subject_iv bytea NOT NULL CHECK (octet_length(subject_iv) = 12),
  subject_ciphertext bytea NOT NULL CHECK (octet_length(subject_ciphertext) BETWEEN 1 AND 1024),
  subject_tag bytea NOT NULL CHECK (octet_length(subject_tag) = 16),
  received_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > received_at)
)`;
export const ebayReceiptSchemaSql = `${table};
CREATE INDEX IF NOT EXISTS channels_ebay_receipts_expiry_idx ON channels_ebay_account_deletion_receipts (expires_at, notification_id);
CREATE INDEX IF NOT EXISTS channels_ebay_receipts_subject_idx ON channels_ebay_account_deletion_receipts (subject_fingerprint, expires_at);`;
export const ebayReceiptSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261011_channels_ebay_account_deletion_receipts",
    description: "Persist expiring encrypted eBay account-deletion receipts with stable subject matching.",
    statements: [
      table,
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_ebay_receipts_expiry_idx ON channels_ebay_account_deletion_receipts (expires_at, notification_id)",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_ebay_receipts_subject_idx ON channels_ebay_account_deletion_receipts (subject_fingerprint, expires_at)",
    ],
  },
];
