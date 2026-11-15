import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { StoredEvent } from "@chase-sets/event-core/storage";

type DiagnosticEvent = Pick<StoredEvent, "eventType" | "streamVersion" | "occurredAt" | "payload">;

export function managedOfferEvaluations(events: readonly DiagnosticEvent[]) {
  return events
    .filter((event) => event.eventType === "marketplace.offer.managed-evaluated")
    .map((event) => {
      const evidence = event.payload.evidence;
      return {
        streamVersion: event.streamVersion,
        occurredAt: event.occurredAt,
        status: event.payload.status,
        reason: event.payload.reason,
        policyVersion: event.payload.policyVersion,
        operationId: event.payload.operationId,
        evidence:
          evidence && typeof evidence === "object" && !Array.isArray(evidence)
            ? { marketPrice: evidence.marketPrice ?? null, evaluatedAt: evidence.evaluatedAt ?? null }
            : null,
      };
    });
}

/** Product-scoped authoritative work, including claims not yet projected into the work queue. */
export async function readManagedOfferWorkDiagnostics(
  db: PgQueryable,
  product: { catalogItemId: string; productId: string },
  events: readonly DiagnosticEvent[],
) {
  const evaluationWorkStreams = managedOfferEvaluations(events).flatMap((evaluation) => {
    const match = typeof evaluation.operationId === "string" && /^([a-f0-9]{64})_/.exec(evaluation.operationId);
    return match ? [`marketplace.offer-work-${match[1]}`] : [];
  });
  const result = await db.query<{
    stream_id: string;
    stream_version: string;
    event_type: string;
    occurred_at: Date;
    payload: Record<string, unknown>;
  }>(
    `WITH product_work AS (
       SELECT stream_id FROM event_store_events
       WHERE event_type = 'marketplace.offer.work-requested'
         AND payload->>'catalogItemId' = $1 AND payload->>'productId' = $2
       ORDER BY global_position DESC LIMIT 20
     )
     SELECT stream_id, stream_version::text, event_type, occurred_at, payload
     FROM event_store_events
     WHERE (stream_id IN (SELECT stream_id FROM product_work) OR stream_id = ANY($3::text[]))
       AND event_type IN ('marketplace.offer.work-requested', 'marketplace.offer.work-claimed',
                          'marketplace.offer.work-progressed')
     ORDER BY global_position DESC LIMIT 501`,
    [product.catalogItemId, product.productId, evaluationWorkStreams],
  );
  return {
    productWorkLimit: 20,
    eventLimit: 500,
    truncated: result.rows.length > 500,
    events: result.rows.slice(0, 500).map((row) => ({
      streamId: row.stream_id,
      streamVersion: row.stream_version,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      workId: row.payload.workId,
      catalogItemId: row.payload.catalogItemId,
      productId: row.payload.productId,
      kind: row.payload.kind ?? "reaction",
      status: row.payload.status,
      availableAt: row.payload.availableAt,
      afterOfferId: row.payload.afterOfferId,
      page: row.payload.page ?? null,
    })),
  };
}
