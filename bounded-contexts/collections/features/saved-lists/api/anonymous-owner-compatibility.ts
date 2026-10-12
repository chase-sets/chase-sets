import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { savedListCanonicalIdentifier, savedListFingerprint } from "./anonymous-owner";

export function createAnonymousOwnerCompatibility(db: PgQueryable) {
  return {
    async resolve(rawOwner: string, intentId: string | null = null): Promise<string> {
      const raw = savedListCanonicalIdentifier(rawOwner);
      if (!raw.startsWith("anon_")) throw new Error("Invalid anonymous Saved List owner.");
      const fingerprint = savedListFingerprint(["collections.anonymous-owner.v1", raw]);
      const legacy = await db.query<{ intent_id: string; owner_revision: number }>(
        `SELECT intent_id, owner_revision FROM collections_anonymous_saved_list_intents
         WHERE anonymous_owner_id = $1 AND anonymous_owner_fingerprint IS NULL
           AND (intent_id = $2 OR ($2::text IS NULL AND status = 'active'))`,
        [raw, intentId],
      );
      for (const row of legacy.rows) {
        await db.query(
          `UPDATE collections_anonymous_saved_list_intents
           SET anonymous_owner_fingerprint = $3, owner_revision = owner_revision + 1
           WHERE intent_id = $1 AND owner_revision = $2
             AND anonymous_owner_id = $4 AND anonymous_owner_fingerprint IS NULL`,
          [row.intent_id, row.owner_revision, fingerprint, raw],
        );
      }
      return fingerprint;
    },
    async insert<Row>(sql: string, values: readonly unknown[], rawOwner: string) {
      return db.query<Row>(sql, [...values, savedListCanonicalIdentifier(rawOwner)]);
    },
  };
}
