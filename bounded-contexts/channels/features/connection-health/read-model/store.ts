import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { decodeChannelHealthSnapshot } from "../domain/codecs";
import type { ChannelHealthSnapshot } from "../domain/contracts";

export async function readHealthSnapshot(db: PgQueryable, connectionId: string): Promise<ChannelHealthSnapshot | null> {
  const result = await db.query<{ snapshot: unknown }>(
    `SELECT jsonb_build_object('policyRevision', policy_revision, 'evaluationGeneration', evaluation_generation,
      'state', state, 'reasons', reasons, 'observedAt', observed_at) AS snapshot
     FROM channel_connection_health WHERE connection_id = $1 FOR UPDATE`,
    [connectionId],
  );
  return result.rows[0] ? decodeChannelHealthSnapshot(result.rows[0].snapshot) : null;
}

export async function writeHealthSnapshot(
  db: PgQueryable,
  connectionId: string,
  previous: ChannelHealthSnapshot,
  next: ChannelHealthSnapshot,
): Promise<number> {
  const result = await db.query(
    `UPDATE channel_connection_health SET policy_revision = $2, evaluation_generation = $3, state = $4, reasons = $5::jsonb, observed_at = $6
     WHERE connection_id = $1 AND policy_revision = $7 AND evaluation_generation = $8 AND state = $9
       AND reasons = $10::jsonb AND observed_at IS NOT DISTINCT FROM $11 RETURNING connection_id`,
    [
      connectionId,
      next.policyRevision,
      next.evaluationGeneration,
      next.state,
      JSON.stringify(next.reasons),
      next.observedAt,
      previous.policyRevision,
      previous.evaluationGeneration,
      previous.state,
      JSON.stringify(previous.reasons),
      previous.observedAt,
    ],
  );
  // Comparing the entire reason vector binds every reason generation, fingerprint, and open/closed state.
  return result.rows.length;
}

export async function readTrailingFailures(db: PgQueryable, connectionId: string, now: string, windowSeconds: number) {
  const result = await db.query<{ reason_code: string; reason_generation: string; failures: string }>(
    `SELECT reason_code, reason_generation::text, count(*)::text AS failures FROM channel_health_observations
     WHERE connection_id = $1 AND occurred_at >= $2::timestamptz - make_interval(secs => $3)
       AND occurred_at <= $2::timestamptz AND outcome = 'failure'
     GROUP BY reason_code, reason_generation`,
    [connectionId, now, windowSeconds],
  );
  return (reason: string, generation: number) =>
    Number(
      result.rows.find((row) => row.reason_code === reason && Number(row.reason_generation) === generation)?.failures ??
        0,
    );
}
