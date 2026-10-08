import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { ChannelAttentionError } from "../domain/contracts";
import type { ChannelExternalSaleUnmappableReason } from "../../reconciliation/read-model/sale-target";
import type { ChannelOrderAttentionPage, ChannelOrderAttentionReason } from "../domain/order-contribution";
type AffectedLines = readonly Readonly<{ identity: string; detail: ChannelExternalSaleUnmappableReason | null }>[];

export async function readOrderAttention(
  db: PgQueryable,
  accountId: string,
  connectionId: string,
  after?: string,
): Promise<ChannelOrderAttentionPage> {
  return (await readOrderAttentionBatch(db, accountId, [connectionId], after)).get(connectionId)!;
}

export async function readOrderAttentionBatch(
  db: PgQueryable,
  accountId: string,
  connectionIds: readonly string[],
  after?: string,
): Promise<ReadonlyMap<string, ChannelOrderAttentionPage>> {
  let cursor: readonly string[] = ["", ""];
  if (after !== undefined) {
    if (after.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(after))
      throw new ChannelAttentionError("invalid-attention-contract");
    const decoded: unknown = JSON.parse(Buffer.from(after, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2 || decoded.some((value) => typeof value !== "string"))
      throw new ChannelAttentionError("invalid-attention-contract");
    cursor = decoded;
  }
  type OrderRow = {
    order_reference: string;
    reason: ChannelOrderAttentionReason;
    generation: string;
    opened_at: Date | string;
    affected_line_count: number;
  };
  const result = await db.query<{ connection_id: string; items: OrderRow[]; total: number }>(
    `SELECT connection_id,
      (SELECT coalesce(jsonb_agg(page ORDER BY order_reference,reason),'[]'::jsonb) FROM (
        SELECT order_reference,reason,generation::text,opened_at,jsonb_array_length(affected_lines) AS affected_line_count
        FROM channel_order_attention WHERE account_id=$1 AND connection_id=selected.connection_id AND resolved_at IS NULL
          AND (order_reference,reason)>($3,$4) ORDER BY order_reference,reason LIMIT 101
      ) AS page) AS items,
      (SELECT count(*)::int FROM (
        SELECT 1 FROM channel_order_attention WHERE account_id=$1 AND connection_id=selected.connection_id
          AND resolved_at IS NULL LIMIT 101
      ) AS bounded) AS total
    FROM unnest($2::text[]) AS selected(connection_id)`,
    [accountId, connectionIds, cursor[0], cursor[1]],
  );
  return new Map(
    result.rows.map((page) => {
      const items = page.items.slice(0, 100).map((row) => ({
        externalOrderReference: row.order_reference,
        reason: row.reason,
        generation: Number(row.generation),
        openedAt: new Date(row.opened_at).toISOString(),
        affectedLineCount: row.affected_line_count,
      }));
      const last = items.at(-1);
      return [
        page.connection_id,
        {
          items,
          count: Math.min(page.total, 100),
          hasMore: page.total > 100,
          nextCursor:
            page.items.length > 100 && last
              ? Buffer.from(JSON.stringify([last.externalOrderReference, last.reason])).toString("base64url")
              : null,
        },
      ];
    }),
  );
}

// The caller holds the connection interpretation fence. A changed contribution opens a new generation;
// an identical retry performs no write, and sticky reasons never auto-resolve.
export async function reconcileOrderAttention(
  db: PgQueryable,
  accountId: string,
  connectionId: string,
  orderReference: string,
  now: string,
) {
  const desired = await db.query<{
    reason: ChannelOrderAttentionReason;
    lines: AffectedLines;
  }>(
    `SELECT outcome->>'reason' AS reason,
      jsonb_agg(DISTINCT jsonb_build_object('identity',outcome->>'identity','detail',outcome->'detail')) AS lines
     FROM channel_order_observations, jsonb_array_elements(line_outcomes) AS outcome
     WHERE connection_id=$1 AND order_reference=$2 AND outcome->>'reason' IS NOT NULL
     GROUP BY outcome->>'reason'`,
    [connectionId, orderReference],
  );
  for (const row of desired.rows) {
    const lines = [...row.lines].sort(
      (a, b) => a.identity.localeCompare(b.identity) || (a.detail ?? "").localeCompare(b.detail ?? ""),
    );
    await db.query(
      `INSERT INTO channel_order_attention
      (account_id,connection_id,order_reference,reason,generation,affected_lines,opened_at)
      VALUES ($1,$2,$3,$4,1,$5::jsonb,$6)
      ON CONFLICT (connection_id,order_reference,reason) DO UPDATE
      SET generation=channel_order_attention.generation+1, affected_lines=EXCLUDED.affected_lines,
          opened_at=EXCLUDED.opened_at,resolved_at=NULL
      WHERE (channel_order_attention.resolved_at IS NOT NULL OR channel_order_attention.affected_lines<>EXCLUDED.affected_lines)
        AND channel_order_attention.reason NOT IN ('backdated-sale','tcgplayer-order-cancelled')`,
      [accountId, connectionId, orderReference, row.reason, JSON.stringify(lines), now],
    );
  }
  await db.query(
    `UPDATE channel_order_attention SET resolved_at=$4
    WHERE account_id=$1 AND connection_id=$2 AND order_reference=$3 AND resolved_at IS NULL
      AND reason NOT IN ('backdated-sale','tcgplayer-order-cancelled') AND NOT (reason=ANY($5::text[]))`,
    [accountId, connectionId, orderReference, now, desired.rows.map((row) => row.reason)],
  );
}
