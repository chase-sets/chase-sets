import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { SELLER_ATTENTION_SEVERITY_RANK } from "@chase-sets/seller-attention-queue";
import { identity } from "../../connection-health/domain/codecs";
import { openHealthReasonGenerations, readAccountHealthSnapshots } from "../../connection-health/read-model/store";
import {
  manualAttentionQuerySql,
  readManualAttentionContributions,
} from "../../manual-sync/read-model/attention-query";
import { ChannelAttentionError, type ChannelConnectionAttention } from "../domain/contracts";

const openHealthSql = `SELECT health.connection_id, reason, (reason->'opening'->>'occurredAt')::timestamptz AS opened_at
  FROM channel_connection_health AS health CROSS JOIN LATERAL jsonb_array_elements(health.reasons) AS reason
  WHERE health.account_id=$1 AND reason->>'state' <> 'closed'
    AND NOT (reason->>'reasonCode'='drift' AND EXISTS (
      SELECT 1 FROM channel_reconciliation_state AS run WHERE run.connection_id=health.connection_id
        AND run.account_id=health.account_id AND run.drift_generation->>'fingerprint'=reason->>'fingerprint'
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(run.drift_generation->'members') AS member
          WHERE member->>'kind' IN ('foreign-edit','structural'))))
    AND NOT EXISTS (SELECT 1 FROM channel_connection_attention AS attention
      WHERE attention.account_id=$1 AND attention.connection_id=health.connection_id
        AND attention.reason_code=reason->>'reasonCode'
        AND attention.reason_generation=(reason->>'generation')::bigint
        AND attention.fingerprint=reason->>'fingerprint' AND attention.resolved_at IS NOT NULL)`;

export async function readConnectionAttention(
  db: PgQueryable,
  input: Readonly<{ accountId: string; connectionId?: string }>,
): Promise<readonly ChannelConnectionAttention[]> {
  const accountId = identity(input.accountId);
  const connectionId = input.connectionId === undefined ? null : identity(input.connectionId);
  const keys = await db.query<{ connection_id: string }>(
    connectionId === null
      ? `
    WITH manual AS (${manualAttentionQuerySql}), health AS (${openHealthSql}),
    eligible AS (SELECT connection_id, observed_at::timestamptz AS opened_at,
      CASE WHEN clamp_state='recovery' OR run_state='application-unknown' THEN $3::int ELSE $4::int END AS severity_rank FROM manual
      UNION ALL SELECT connection_id, opened_at,
        CASE WHEN reason->>'state'='failing' THEN $2::int ELSE $3::int END AS severity_rank FROM health)
    SELECT connection_id FROM eligible GROUP BY connection_id
    ORDER BY max(severity_rank) DESC, min(opened_at), connection_id LIMIT 100`
      : `SELECT connection_id FROM channel_connections WHERE account_id=$1 AND connection_id=$2`,
    connectionId === null
      ? [
          accountId,
          SELLER_ATTENTION_SEVERITY_RANK.critical,
          SELLER_ATTENTION_SEVERITY_RANK.warning,
          SELLER_ATTENTION_SEVERITY_RANK.info,
        ]
      : [accountId, connectionId],
  );
  if (connectionId !== null && keys.rows.length === 0) throw new ChannelAttentionError("connection-not-found");
  const ids = keys.rows.map((row) => row.connection_id);
  if (ids.length === 0) return [];
  const [manual, health, resolutions] = await Promise.all([
    readManualAttentionContributions(db, accountId, ids),
    readAccountHealthSnapshots(db, accountId, ids),
    db.query<{
      connection_id: string;
      reason_code: string | null;
      reason_generation: string | null;
      fingerprint: string | null;
      affected_count: number | null;
      drift_visible: boolean | null;
    }>(
      `
      SELECT connection.connection_id,attention.reason_code,attention.reason_generation::text,attention.fingerprint,
        CASE WHEN run.drift_generation IS NULL THEN NULL ELSE (
          SELECT count(*)::int FROM jsonb_array_elements(run.drift_generation->'members') AS member
          WHERE member->>'settlement'='open' AND member->>'kind' IN ('foreign-edit','structural')
        ) END AS affected_count,
        CASE WHEN run.drift_generation IS NULL THEN NULL ELSE EXISTS (
          SELECT 1 FROM jsonb_array_elements(run.drift_generation->'members') AS member
          WHERE member->>'kind' IN ('foreign-edit','structural')) END AS drift_visible
      FROM channel_connections AS connection
      LEFT JOIN channel_connection_health AS health ON health.connection_id=connection.connection_id AND health.account_id=connection.account_id
      LEFT JOIN channel_reconciliation_state AS run ON run.connection_id=connection.connection_id AND run.account_id=connection.account_id
        AND health.reasons @> jsonb_build_array(jsonb_build_object('reasonCode','drift','fingerprint',run.drift_generation->>'fingerprint'))
      LEFT JOIN channel_connection_attention AS attention ON attention.connection_id=connection.connection_id
        AND attention.account_id=connection.account_id AND attention.resolved_at IS NOT NULL
        AND health.reasons @> jsonb_build_array(jsonb_build_object('reasonCode',attention.reason_code,'generation',attention.reason_generation,'fingerprint',attention.fingerprint))
      WHERE connection.account_id=$1 AND connection.connection_id=ANY($2::text[])`,
      [accountId, ids],
    ),
  ]);
  return ids.map((id) => {
    const snapshot = health.get(id);
    const affected = resolutions.rows.find((row) => row.connection_id === id)?.affected_count;
    return {
      connectionId: id,
      healthState: snapshot?.state ?? "unknown",
      health: (snapshot ? openHealthReasonGenerations(snapshot) : []).filter(
        (reason) =>
          (reason.reasonCode !== "drift" ||
            resolutions.rows.find((row) => row.connection_id === id)?.drift_visible !== false) &&
          !resolutions.rows.some(
            (row) =>
              row.connection_id === id &&
              row.reason_code === reason.reasonCode &&
              Number(row.reason_generation) === reason.generation &&
              row.fingerprint === reason.fingerprint,
          ),
      ),
      manual: manual.find((row) => row.connectionId === id) ?? null,
      ...(affected === null || affected === undefined
        ? {}
        : {
            drift: {
              affectedListingCount: Math.min(affected, 100),
              hasMore: affected > 100 ? (1 as const) : (0 as const),
            },
          }),
    };
  });
}
