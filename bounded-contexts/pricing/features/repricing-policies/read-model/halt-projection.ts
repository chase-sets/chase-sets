import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildRepricingHaltProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const handler: ProjectorHandlerMap[string] = async (event) => {
    const engaged = event.type === "pricing.repricing-halt.engaged";
    const { changedAt } = event.data as { changedAt: string };
    await db.query(
      `INSERT INTO pricing_repricing_halts AS halt
         (seller_account_id, engaged, engaged_at, released_at, updated_at, last_stream_version)
       VALUES ($1, $2, CASE WHEN $2 THEN $3::timestamptz END,
         CASE WHEN NOT $2 THEN $3::timestamptz END, $3, $4)
       ON CONFLICT (seller_account_id) DO UPDATE SET
         engaged = EXCLUDED.engaged,
         engaged_at = COALESCE(EXCLUDED.engaged_at, halt.engaged_at),
         released_at = COALESCE(EXCLUDED.released_at, halt.released_at),
         updated_at = EXCLUDED.updated_at,
         last_stream_version = EXCLUDED.last_stream_version
       WHERE halt.last_stream_version < EXCLUDED.last_stream_version`,
      [extractIdFromStreamId(event.streamId, "pricing.repricing-halt-"), engaged, changedAt, event.streamVersion],
    );
  };
  return { "pricing.repricing-halt.engaged": handler, "pricing.repricing-halt.released": handler };
}
