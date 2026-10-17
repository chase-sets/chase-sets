import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type ManualAttentionContribution = Readonly<{
  connectionId: string;
  reason: "ready" | "unknown" | "recovery";
  observedAt: string;
}>;

export const manualAttentionQuerySql = `SELECT DISTINCT ON (run.connection_id)
              run.connection_id,run.state AS run_state,clamp.state AS clamp_state,
              greatest(run.updated_at,coalesce(clamp.updated_at,run.updated_at)) AS observed_at
         FROM channel_sync_runs AS run
         JOIN channel_connections AS connection ON connection.connection_id=run.connection_id
         LEFT JOIN channels_manual_sync_clamp_status AS clamp ON clamp.run_id=run.run_id
        WHERE connection.account_id=$1 AND run.claimant_kind='manual'
          AND (run.state IN ('composed','application-unknown') OR clamp.state='recovery')
        ORDER BY run.connection_id,run.sequence DESC`;

export async function readManualAttentionContributions(
  db: PgQueryable,
  accountId: string,
  connectionIds: readonly string[],
): Promise<readonly ManualAttentionContribution[]> {
  if (connectionIds.length > 100) throw new Error("invalid-attention-page");
  const result = await db.query<{
    connection_id: string;
    run_state: string;
    clamp_state: string | null;
    observed_at: string | Date;
  }>(`SELECT * FROM (${manualAttentionQuerySql}) AS manual WHERE connection_id = ANY($2::text[])`, [
    accountId,
    connectionIds,
  ]);
  return result.rows.map((row) => ({
    connectionId: row.connection_id,
    reason: row.clamp_state === "recovery" ? "recovery" : row.run_state === "application-unknown" ? "unknown" : "ready",
    observedAt: row.observed_at instanceof Date ? row.observed_at.toISOString() : row.observed_at,
  }));
}
