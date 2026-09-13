import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildSellerAttentionItem,
  type SellerAttentionItem,
  type SellerAttentionSource,
} from "@chase-sets/seller-attention-queue";

type ChannelActionAttentionRow = Readonly<{
  connectionId: string;
  reason: "ready" | "unknown" | "recovery";
  observedAt: string;
}>;

export function createChannelActionAttentionSource(
  loadRows: (accountId: string) => Promise<readonly ChannelActionAttentionRow[]>,
): SellerAttentionSource {
  return {
    id: "channel-action",
    load: async ({ accountId }) => (await loadRows(accountId)).map(toAttentionItem),
  };
}

export function createChannelActionAttentionSourceFromReadModel(db: PgQueryable): SellerAttentionSource {
  return createChannelActionAttentionSource(async (accountId) => {
    const result = await db.query<{
      connection_id: string;
      run_state: string;
      clamp_state: string | null;
      observed_at: string | Date;
    }>(
      `SELECT DISTINCT ON (run.connection_id)
              run.connection_id,run.state AS run_state,clamp.state AS clamp_state,
              greatest(run.updated_at,coalesce(clamp.updated_at,run.updated_at)) AS observed_at
         FROM channel_sync_runs AS run
         JOIN channel_connections AS connection ON connection.connection_id=run.connection_id
         LEFT JOIN channels_manual_sync_clamp_status AS clamp ON clamp.run_id=run.run_id
        WHERE connection.account_id=$1 AND run.claimant_kind='manual'
          AND (run.state IN ('composed','application-unknown') OR clamp.state='recovery')
        ORDER BY run.connection_id,run.sequence DESC`,
      [accountId],
    );
    return result.rows.map((row) => ({
      connectionId: row.connection_id,
      reason:
        row.clamp_state === "recovery" ? "recovery" : row.run_state === "application-unknown" ? "unknown" : "ready",
      observedAt: row.observed_at instanceof Date ? row.observed_at.toISOString() : row.observed_at,
    }));
  });
}

function toAttentionItem(row: ChannelActionAttentionRow): SellerAttentionItem {
  return buildSellerAttentionItem({
    source: "channel-action",
    entityId: row.connectionId,
    severity: row.reason === "ready" ? "info" : "warning",
    summary: { code: `channel-${row.reason}`, params: { connectionId: row.connectionId } },
    observedAt: row.observedAt,
  });
}
