import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const catalogOperatorSessionGrantSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_operator_session_grants (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  creator_user_id uuid NOT NULL,
  creator_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  last_used_at timestamptz NOT NULL CHECK (isfinite(last_used_at)),
  idle_expires_at timestamptz NOT NULL CHECK (isfinite(idle_expires_at)),
  revoked_at timestamptz NULL CHECK (revoked_at IS NULL OR isfinite(revoked_at)),
  revoke_reason text NULL CHECK (revoke_reason IN ('replaced', 'disconnect', 'unpair')),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);`;

const oneUnrevokedGrantIndexSql = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS catalog_operator_session_one_unrevoked
  ON catalog_operator_session_grants ((true)) WHERE revoked_at IS NULL;`;

// An interrupted concurrent build can leave an invalid index that IF NOT EXISTS skips.
const requireValidGrantIndexSql = `DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index WHERE indexrelid = 'catalog_operator_session_one_unrevoked'::regclass
      AND indisvalid AND indisunique
  ) THEN
    RAISE EXCEPTION 'operator session grant index unavailable';
  END IF;
END $$;`;

const creatorIdentityTextSql = `DO $$ BEGIN
  SET LOCAL lock_timeout = '5s';
  ALTER TABLE catalog_operator_session_grants
    ALTER COLUMN creator_user_id TYPE text USING creator_user_id::text,
    ALTER COLUMN creator_membership_id TYPE text USING creator_membership_id::text;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'catalog_operator_session_grants'::regclass
      AND conname = 'catalog_operator_session_grants_creator_user_id_bounded'
  ) THEN
    ALTER TABLE catalog_operator_session_grants
      ADD CONSTRAINT catalog_operator_session_grants_creator_user_id_bounded
      CHECK (char_length(creator_user_id) BETWEEN 1 AND 128) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'catalog_operator_session_grants'::regclass
      AND conname = 'catalog_operator_session_grants_creator_membership_id_bounded'
  ) THEN
    ALTER TABLE catalog_operator_session_grants
      ADD CONSTRAINT catalog_operator_session_grants_creator_membership_id_bounded
      CHECK (char_length(creator_membership_id) BETWEEN 1 AND 128) NOT VALID;
  END IF;
END $$;`;

const validateCreatorIdentitySql = `DO $$ BEGIN
  SET LOCAL lock_timeout = '5s';
  ALTER TABLE catalog_operator_session_grants
    VALIDATE CONSTRAINT catalog_operator_session_grants_creator_user_id_bounded,
    VALIDATE CONSTRAINT catalog_operator_session_grants_creator_membership_id_bounded;
END $$;`;

export const catalogOperatorSessionGrantSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261002_catalog_operator_session_grants_v1",
    description: "Hash-only operator push grants with one unrevoked authority.",
    statements: [catalogOperatorSessionGrantSchemaSql, oneUnrevokedGrantIndexSql, requireValidGrantIndexSql],
  },
  {
    migrationId: "20261013_catalog_operator_session_grant_creator_ids_text_v2",
    description: "Store bounded Identity-compatible grant creator ids as text, preserving retained UUID values.",
    statements: [creatorIdentityTextSql, validateCreatorIdentitySql, requireValidGrantIndexSql],
  },
];
