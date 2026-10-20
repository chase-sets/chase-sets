import { type PgQueryable, type PgTransactionalPool, withPgTransaction } from "@chase-sets/event-core-postgres";
import { readAnonymousOwnerActivation } from "../../../support/runtime-support/anonymous-owner-activation";
import { savedListCanonicalIdentifier, savedListFingerprint } from "./anonymous-owner";

/** The legacy raw-owner count `observe()` runs; capture tooling explains this exact statement. */
export const legacyAnonymousOwnerCountSql = `SELECT count(*)::text AS remaining
    FROM collections_anonymous_saved_list_intents WHERE anonymous_owner_id IS NOT NULL`;

async function observe(db: PgQueryable) {
  try {
    const activation = await readAnonymousOwnerActivation(db, "none");
    const ledger = await db.query<{ migration_id: string }>(
      "SELECT migration_id FROM bounded_context_schema_migrations ORDER BY migration_id",
    );
    const fence = await db.query<{ present: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = 'public' AND c.relname = 'collections_anonymous_saved_list_intents'
      AND t.tgname = 'collections_anonymous_owner_raw_fence' AND t.tgenabled IN ('O', 'A')
      AND p.proname = 'collections_anonymous_owner_raw_fence' AND NOT t.tgisinternal
  ) AS present`);
    const count = await db.query<{ remaining: string }>(legacyAnonymousOwnerCountSql);
    return {
      activation,
      schemaLedger: ledger.rows.map((row) => row.migration_id),
      fencePresent: fence.rows[0]?.present === true,
      remaining: Number(count.rows[0]?.remaining),
    };
  } catch {
    throw new Error("redaction-observation-failed");
  }
}

/** Counts and closed codes only: database rows and exceptions never cross this boundary. */
export async function redactLegacyAnonymousOwners(
  pool: PgTransactionalPool,
  options: Readonly<{ dryRun: boolean; authorize?: (snapshot: Awaited<ReturnType<typeof observe>>) => void }>,
) {
  const started = Date.now();
  const before = await observe(pool);
  await options.authorize?.(before);
  let processed = 0;
  let mismatches = 0;
  const codes: ("fingerprint-mismatch" | "mutation-uncertain" | "activation-required")[] = [];
  if (!options.dryRun) {
    if (!before.activation.activated_at) codes.push("activation-required");
    else {
      let cursor: string | null = null;
      for (let batch = 0; batch < 10; batch++) {
        try {
          const result = await withPgTransaction(pool, async (db) => {
            const activation = await readAnonymousOwnerActivation(db);
            if (!activation.activated_at) return { processed: 0, mismatches: 0, last: cursor, size: 0 };
            const rows = await db.query<{
              intent_id: string;
              owner_revision: number;
              anonymous_owner_id: string;
              anonymous_owner_fingerprint: string | null;
            }>(
              `SELECT intent_id, owner_revision, anonymous_owner_id, anonymous_owner_fingerprint
              FROM collections_anonymous_saved_list_intents
              WHERE anonymous_owner_id IS NOT NULL AND ($1::text IS NULL OR intent_id > $1)
              ORDER BY intent_id LIMIT 500 FOR UPDATE SKIP LOCKED`,
              [cursor],
            );
            let changed = 0;
            let mismatch = 0;
            for (const row of rows.rows) {
              const raw = savedListCanonicalIdentifier(row.anonymous_owner_id);
              const fingerprint = savedListFingerprint(["collections.anonymous-owner.v1", raw]);
              if (row.anonymous_owner_fingerprint !== null && row.anonymous_owner_fingerprint !== fingerprint) {
                mismatch++;
                continue;
              }
              const updated = await db.query(
                `UPDATE collections_anonymous_saved_list_intents
                SET anonymous_owner_id = NULL, anonymous_owner_fingerprint = $4, owner_revision = owner_revision + 1
                WHERE intent_id = $1 AND owner_revision = $2 AND anonymous_owner_id = $3
                  AND (anonymous_owner_fingerprint IS NULL OR anonymous_owner_fingerprint = $4)`,
                [row.intent_id, row.owner_revision, raw, fingerprint],
              );
              changed += updated.rowCount ?? 0;
            }
            return {
              processed: changed,
              mismatches: mismatch,
              last: rows.rows.at(-1)?.intent_id ?? cursor,
              size: rows.rows.length,
            };
          });
          processed += result.processed;
          mismatches += result.mismatches;
          cursor = result.last;
          if (result.size < 500) break;
        } catch {
          // A lost COMMIT acknowledgement must never cause a blind replay. Read back below.
          codes.push("mutation-uncertain");
          break;
        }
      }
    }
  }
  if (mismatches > 0) codes.push("fingerprint-mismatch");
  const after = options.dryRun ? before : await observe(pool);
  return {
    activation: after.activation,
    schemaLedger: after.schemaLedger,
    fencePresent: after.fencePresent,
    before: before.remaining,
    processed,
    after: after.remaining,
    mismatches,
    durationMs: Date.now() - started,
    codes,
  };
}
