import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type CatalogAttentionDismissalRow = Readonly<{
  item_key: string;
  kind: string;
  disposition: "dismissed" | "deferred";
  reason: string | null;
  deferred_until: string | null;
  actor: string;
  updated_at: string;
}>;

// Whether a dismissal row parks its item at `nowSql`: dismissed until restored, or
// deferred with a re-surface time still ahead. Deferred rows past their window no
// longer park, so those items age back in.
function activeDismissalSql(alias: string, nowSql: string): string {
  return `(${alias}.disposition = 'dismissed'
        OR (${alias}.disposition = 'deferred' AND ${alias}.deferred_until IS NOT NULL AND ${alias}.deferred_until > ${nowSql}))`;
}

// SQL predicate: the attention item whose key is `itemKeySql` is parked at
// `nowSql`. Source counts and windows exclude parked rows with it before paging,
// so every read of one queue judges parking at the same clock.
export function catalogAttentionItemParkedSql(itemKeySql: string, nowSql: string): string {
  return `EXISTS (
       SELECT 1
       FROM catalog_attention_dismissals parked
       WHERE parked.item_key = ${itemKeySql}
         AND ${activeDismissalSql("parked", nowSql)}
     )`;
}

// The parked keys among `itemKeys` (items observed in memory rather than read
// from a queue source table), judged at `now`.
export async function listActiveAttentionDismissalKeys(
  db: PgQueryable,
  options: Readonly<{ now: string; itemKeys: readonly string[] }>,
): Promise<ReadonlySet<string>> {
  if (options.itemKeys.length === 0) {
    return new Set();
  }
  const result = await db.query<{ item_key: string }>(
    `SELECT dismissal.item_key
     FROM catalog_attention_dismissals dismissal
     WHERE dismissal.item_key = ANY($2::text[])
       AND ${activeDismissalSql("dismissal", "$1")}`,
    [options.now, [...new Set(options.itemKeys)]],
  );
  return new Set(result.rows.map((row) => row.item_key));
}

export async function listAttentionDismissals(db: PgQueryable): Promise<readonly CatalogAttentionDismissalRow[]> {
  const result = await db.query<CatalogAttentionDismissalRow>(
    `SELECT item_key, kind, disposition, reason, deferred_until, actor, updated_at
     FROM catalog_attention_dismissals
     ORDER BY updated_at DESC, item_key ASC`,
  );
  return result.rows;
}
