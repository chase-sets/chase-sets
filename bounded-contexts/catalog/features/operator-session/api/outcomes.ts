import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  nextOperatorSessionOutcome,
  operatorSessionOutcomeFromRow,
  sameOperatorSessionIdentity,
  validOperatorSessionIdentity,
  type OperatorSessionIdentity,
  type OperatorSessionOutcomeRow,
} from "../domain/readiness";

export async function lockOperatorSessionReadiness(db: PgQueryable): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock($1::bigint)", ["84558450"]);
}

export async function resetOperatorSessionOutcome(db: PgQueryable): Promise<void> {
  await db.query(`DELETE FROM catalog_tcgplayer_operator_session_outcomes AS outcome
    USING (SELECT source, revision, custody_revision, state, updated_at
      FROM catalog_tcgplayer_operator_session_outcomes WHERE provider_key = 'tcgplayer') AS previous
    WHERE outcome.provider_key = 'tcgplayer' AND outcome.source = previous.source
      AND outcome.revision = previous.revision AND outcome.custody_revision = previous.custody_revision
      AND outcome.state = previous.state AND outcome.updated_at = previous.updated_at`);
}

export type OperatorSessionAttemptOutcome = Readonly<{
  identity: OperatorSessionIdentity;
  status: number;
  rateBudgetContext: "retained" | "unknown";
}>;

export function createOperatorSessionOutcomeRecorder(pool: PgTransactionalPool) {
  return async ({ identity, status, rateBudgetContext }: OperatorSessionAttemptOutcome): Promise<void> => {
    if (
      !validOperatorSessionIdentity(identity) ||
      (!(status >= 200 && status < 300) && status !== 401 && status !== 403)
    )
      return;
    await withPgTransaction(pool, async (db) => {
      await lockOperatorSessionReadiness(db);
      const custody = (
        await db.query<{ state: "stored" | "cleared"; revision: string }>(
          "SELECT state, revision FROM catalog_tcgplayer_operator_sessions WHERE provider_key = 'tcgplayer'",
        )
      ).rows[0];
      const live: OperatorSessionIdentity = {
        source: custody?.state === "stored" ? "operator-session" : "environment",
        revision: custody?.state === "stored" ? Number(custody.revision) : 0,
        custodyRevision: Number(custody?.revision ?? 0),
      };
      if (!sameOperatorSessionIdentity(identity, live)) return;
      const row = (
        await db.query<OperatorSessionOutcomeRow>(
          "SELECT outcome.*, outcome.updated_at::text AS updated_at FROM catalog_tcgplayer_operator_session_outcomes AS outcome WHERE outcome.provider_key = 'tcgplayer'",
        )
      ).rows[0];
      const now = (await db.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.toISOString();
      const next = nextOperatorSessionOutcome(
        identity,
        row ? operatorSessionOutcomeFromRow(row) : null,
        status,
        rateBudgetContext,
        now,
      );
      if (!next) return;
      const values = [
        next.source,
        next.revision,
        next.custodyRevision,
        next.state,
        next.stateSince,
        next.lastRejectionAt,
        next.lastRejectionStatus,
        next.rateBudgetContext,
        next.everSucceeded,
        next.updatedAt,
      ];
      if (!row) {
        await db.query(
          `INSERT INTO catalog_tcgplayer_operator_session_outcomes
          (provider_key, source, revision, custody_revision, state, state_since, last_rejection_at,
           last_rejection_status, rate_budget_context, ever_succeeded, updated_at)
          VALUES ('tcgplayer', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (provider_key) DO NOTHING`,
          values,
        );
      } else {
        await db.query(
          `UPDATE catalog_tcgplayer_operator_session_outcomes SET source = $1, revision = $2,
          custody_revision = $3, state = $4, state_since = $5, last_rejection_at = $6,
          last_rejection_status = $7, rate_budget_context = $8, ever_succeeded = $9, updated_at = $10
          WHERE provider_key = 'tcgplayer' AND source = $11 AND revision = $12 AND custody_revision = $13
            AND state = $14 AND updated_at = $15`,
          [...values, row.source, row.revision, row.custody_revision, row.state, row.updated_at],
        );
      }
    });
  };
}
