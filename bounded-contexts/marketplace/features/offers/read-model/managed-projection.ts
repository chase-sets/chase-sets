import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";

export function buildManagedOfferProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const work: ProjectorHandlerMap[string] = async (event) => {
    await db.query(
      `INSERT INTO marketplace_managed_offer_work
      (work_id, catalog_item_id, product_id, status, available_at, last_stream_version, kind)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (work_id) DO UPDATE SET
      status = EXCLUDED.status, available_at = EXCLUDED.available_at, last_stream_version = EXCLUDED.last_stream_version,
      kind = EXCLUDED.kind
      WHERE marketplace_managed_offer_work.last_stream_version < EXCLUDED.last_stream_version`,
      [
        event.data.workId,
        event.data.catalogItemId,
        event.data.productId,
        event.data.status,
        event.data.availableAt,
        event.streamVersion,
        event.data.kind ?? "reaction",
      ],
    );
  };
  return {
    "marketplace.offer.work-requested": work,
    "marketplace.offer.work-claimed": work,
    "marketplace.offer.work-progressed": work,
    "marketplace.offer.managed-evaluated": async (event) => {
      await db.query(
        `INSERT INTO marketplace_managed_offer_audit
        (offer_id, policy_id, status, reason, evidence, last_stream_version) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
        ON CONFLICT (offer_id) DO UPDATE SET status=EXCLUDED.status, reason=EXCLUDED.reason,
        evidence=EXCLUDED.evidence, last_stream_version=EXCLUDED.last_stream_version
        WHERE marketplace_managed_offer_audit.last_stream_version < EXCLUDED.last_stream_version`,
        [
          event.data.offerId,
          event.data.policyId,
          event.data.status,
          event.data.reason,
          JSON.stringify(event.data.evidence),
          event.streamVersion,
        ],
      );
    },
  };
}
