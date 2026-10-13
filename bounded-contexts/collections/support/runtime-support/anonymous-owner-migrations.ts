import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const anonymousOwnerExpandSql = `ALTER TABLE collections_anonymous_saved_list_intents
  ADD COLUMN IF NOT EXISTS anonymous_owner_fingerprint text NULL,
  ADD COLUMN IF NOT EXISTS owner_revision integer NOT NULL DEFAULT 0 CHECK (owner_revision >= 0);

CREATE INDEX IF NOT EXISTS collections_anonymous_saved_list_intents_fingerprint_active_idx
  ON collections_anonymous_saved_list_intents (anonymous_owner_fingerprint, status, expires_at);`;

export const anonymousOwnerSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261012_collections_anonymous_owner_fingerprint",
    description: "Expand anonymous Saved List ownership without retiring raw-owner readers or writers.",
    statements: [anonymousOwnerExpandSql],
  },
];
