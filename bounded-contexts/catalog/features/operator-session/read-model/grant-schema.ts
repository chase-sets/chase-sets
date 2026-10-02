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

export const catalogOperatorSessionGrantSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261002_catalog_operator_session_grants_v1",
    description: "Hash-only operator push grants with one unrevoked authority.",
    statements: [catalogOperatorSessionGrantSchemaSql, oneUnrevokedGrantIndexSql, requireValidGrantIndexSql],
  },
];
