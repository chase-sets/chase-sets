import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const statements = [
  `CREATE TABLE IF NOT EXISTS channels_ebay_account_deletion_completions (
    notification_id text NOT NULL REFERENCES channels_ebay_account_deletion_receipts(notification_id) ON DELETE CASCADE,
    connection_id text NOT NULL,
    acted_at timestamptz NOT NULL,
    remote_revocation text NOT NULL CHECK (remote_revocation = 'unconfirmed'),
    PRIMARY KEY (notification_id, connection_id)
  )`,
  `DO $$ BEGIN
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE channels_ebay_seller_bindings
    ALTER COLUMN subject_fingerprint DROP NOT NULL,
    ALTER COLUMN subject_key_id DROP NOT NULL,
    ALTER COLUMN iv DROP NOT NULL,
    ALTER COLUMN ciphertext DROP NOT NULL,
    ALTER COLUMN tag DROP NOT NULL;
  END $$`,
  `CREATE INDEX IF NOT EXISTS channels_ebay_seller_subject_idx
    ON channels_ebay_seller_bindings (subject_fingerprint) WHERE subject_fingerprint IS NOT NULL`,
  `DO $$ BEGIN
    SET LOCAL lock_timeout = '5s';
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='channels_ebay_seller_bindings'::regclass AND conname='channels_ebay_seller_identity_custody') THEN
      ALTER TABLE channels_ebay_seller_bindings ADD CONSTRAINT channels_ebay_seller_identity_custody CHECK (
        (subject_fingerprint IS NOT NULL AND subject_key_id IS NOT NULL AND iv IS NOT NULL AND ciphertext IS NOT NULL AND tag IS NOT NULL)
        OR (subject_fingerprint IS NULL AND subject_key_id IS NULL AND iv IS NULL AND ciphertext IS NULL AND tag IS NULL
          AND current_connection_id IS NULL AND credential_reference IS NULL)
      ) NOT VALID;
    END IF;
  END $$`,
  `ALTER TABLE channels_ebay_seller_bindings VALIDATE CONSTRAINT channels_ebay_seller_identity_custody`,
];

export const ebayDeletionConsumerSchemaSql = statements.join(";\n") + ";";
export const ebayDeletionConsumerSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261116_channels_ebay_account_deletion_consumer",
    description: "Remove matched seller identity custody atomically with expiring subject-free completion evidence.",
    statements: statements.map((statement) =>
      statement.replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX CONCURRENTLY IF NOT EXISTS"),
    ),
  },
];
