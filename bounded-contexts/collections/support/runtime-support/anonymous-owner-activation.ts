import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export type AnonymousOwnerActivation = Readonly<{
  singleton: boolean;
  activated_at: string | null;
  gate_packet_sha256: string | null;
  floor_commit: string | null;
}>;

export const anonymousOwnerActivationSchemaSql = `
CREATE TABLE IF NOT EXISTS collections_anonymous_owner_activation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  activated_at timestamptz NULL,
  gate_packet_sha256 text NULL,
  floor_commit text NULL,
  CHECK ((activated_at IS NULL AND gate_packet_sha256 IS NULL AND floor_commit IS NULL)
    OR (activated_at IS NOT NULL AND gate_packet_sha256 IS NOT NULL AND floor_commit IS NOT NULL))
);

INSERT INTO collections_anonymous_owner_activation (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION collections_anonymous_owner_raw_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cutover_active boolean;
BEGIN
  SELECT activated_at IS NOT NULL INTO cutover_active
  FROM collections_anonymous_owner_activation
  WHERE singleton = true
  FOR SHARE;
  IF cutover_active THEN
    IF TG_OP = 'INSERT' AND NEW.anonymous_owner_id IS NOT NULL THEN
      RAISE EXCEPTION 'anonymous-owner-fence';
    ELSIF TG_OP = 'UPDATE' AND NEW.anonymous_owner_id IS DISTINCT FROM OLD.anonymous_owner_id
      AND NEW.anonymous_owner_id IS NOT NULL THEN
      RAISE EXCEPTION 'anonymous-owner-fence';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS collections_anonymous_owner_raw_fence ON collections_anonymous_saved_list_intents;
CREATE TRIGGER collections_anonymous_owner_raw_fence
BEFORE INSERT OR UPDATE OF anonymous_owner_id ON collections_anonymous_saved_list_intents
FOR EACH ROW EXECUTE FUNCTION collections_anonymous_owner_raw_fence();`;

export const anonymousOwnerActivationMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261016_collections_anonymous_owner_activation",
    description: "Expand anonymous Saved List ownership and install the inactive raw-owner fence.",
    statements: [
      "ALTER TABLE collections_anonymous_saved_list_intents ALTER COLUMN anonymous_owner_id DROP NOT NULL;",
      anonymousOwnerActivationSchemaSql,
    ],
  },
];

export async function readAnonymousOwnerActivation(db: PgQueryable, lock = false): Promise<AnonymousOwnerActivation> {
  const result = await db.query<AnonymousOwnerActivation>(
    `SELECT singleton, activated_at::text AS activated_at, gate_packet_sha256, floor_commit
     FROM collections_anonymous_owner_activation WHERE singleton = true${lock ? " FOR UPDATE" : " FOR SHARE"}`,
  );
  return result.rows[0] ?? { singleton: true, activated_at: null, gate_packet_sha256: null, floor_commit: null };
}

export async function activateAnonymousOwnerCutover(
  pool: PgTransactionalPool,
  input: Readonly<{ gatePacketSha256: string; floorCommit: string }>,
): Promise<AnonymousOwnerActivation> {
  return withPgTransaction(pool, async (db) => {
    const current = await readAnonymousOwnerActivation(db, true);
    if (current.activated_at) return current;
    const result = await db.query<AnonymousOwnerActivation>(
      `UPDATE collections_anonymous_owner_activation
       SET activated_at = now(), gate_packet_sha256 = $1, floor_commit = $2
       WHERE singleton = true AND activated_at IS NULL
       RETURNING singleton, activated_at::text AS activated_at, gate_packet_sha256, floor_commit`,
      [input.gatePacketSha256, input.floorCommit],
    );
    return result.rows[0] ?? current;
  });
}
