import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

// Projects the attention-item dismissal aggregate into the queryable
// `catalog_attention_dismissals` read model. Dismiss/defer upsert the parked
// row; restore drops it so the item ages straight back into the queue.
export function buildCatalogAttentionDismissalProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.attention-item.dismissed": async (event) => {
      const data = event.data as { itemKey: string; kind: string; actor: string; reason: string };
      await upsertParkedItem(db, {
        itemKey: data.itemKey,
        kind: data.kind,
        disposition: "dismissed",
        reason: data.reason,
        deferredUntil: null,
        actor: data.actor,
        updatedAt: event.timing.recordedAt,
      });
    },
    "catalog.attention-item.deferred": async (event) => {
      const data = event.data as {
        itemKey: string;
        kind: string;
        actor: string;
        reason: string;
        deferredUntil: string;
      };
      await upsertParkedItem(db, {
        itemKey: data.itemKey,
        kind: data.kind,
        disposition: "deferred",
        reason: data.reason,
        deferredUntil: data.deferredUntil,
        actor: data.actor,
        updatedAt: event.timing.recordedAt,
      });
    },
    "catalog.attention-item.restored": async (event) => {
      const data = event.data as { itemKey: string };
      await db.query(`DELETE FROM catalog_attention_dismissals WHERE item_key = $1`, [data.itemKey]);
    },
  };
}

async function upsertParkedItem(
  db: PgQueryable,
  row: Readonly<{
    itemKey: string;
    kind: string;
    disposition: "dismissed" | "deferred";
    reason: string | null;
    deferredUntil: string | null;
    actor: string;
    updatedAt: string;
  }>,
): Promise<void> {
  await db.query(
    `INSERT INTO catalog_attention_dismissals (item_key, kind, disposition, reason, deferred_until, actor, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (item_key) DO UPDATE SET
       kind = EXCLUDED.kind,
       disposition = EXCLUDED.disposition,
       reason = EXCLUDED.reason,
       deferred_until = EXCLUDED.deferred_until,
       actor = EXCLUDED.actor,
       updated_at = EXCLUDED.updated_at`,
    [row.itemKey, row.kind, row.disposition, row.reason, row.deferredUntil, row.actor, row.updatedAt],
  );
}
