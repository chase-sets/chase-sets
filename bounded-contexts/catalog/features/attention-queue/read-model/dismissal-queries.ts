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

// The item keys currently suppressed from the queue: dismissed items (until
// restored) and deferred items whose re-surface time has not yet elapsed.
// Deferred items past their window are intentionally excluded so they age back in.
export async function listActiveAttentionDismissalKeys(
  db: PgQueryable,
  options: Readonly<{ now: string }>,
): Promise<ReadonlySet<string>> {
  const result = await db.query<{ item_key: string }>(
    `SELECT item_key
     FROM catalog_attention_dismissals
     WHERE disposition = 'dismissed'
        OR (disposition = 'deferred' AND deferred_until IS NOT NULL AND deferred_until > $1)`,
    [options.now],
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
