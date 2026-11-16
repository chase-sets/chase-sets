import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { StoredEvent } from "@chase-sets/event-core/storage";

type DiagnosticEvent = Pick<StoredEvent, "eventType" | "streamVersion" | "occurredAt" | "payload">;

function pricingEvidence(evidence: Record<string, unknown> | null) {
  const price = evidence?.marketPrice;
  return {
    policyRevision: evidence?.policyRevision ?? null,
    evaluatedAt: evidence?.evaluatedAt ?? null,
    marketPrice:
      price && typeof price === "object" && !Array.isArray(price)
        ? Object.fromEntries(
            [
              "catalogItemId",
              "productId",
              "estimateVersion",
              "amount",
              "currencyCode",
              "estimatedAt",
              "freshUntil",
            ].map((key) => [key, (price as Record<string, unknown>)[key] ?? null]),
          )
        : null,
  };
}

/** Follow-up SQL snapshot of the two held branches in the seller Match query, not an HTTP observation. */
export async function readManagedOfferFulfillmentAuthority(db: PgQueryable, offerId: string, policyId: string) {
  const result = await db.query<{
    policy_status: string | null;
    policy_revision: number | null;
    policy_projection_version: number | null;
    policy_stream_version: number | null;
    audit_status: string | null;
    audit_reason: string | null;
    audit_stream_version: number | null;
    audit_evidence: Record<string, unknown> | null;
    consent_result: {
      status?: string;
      reason?: string;
      unitItemAmount?: string;
      evidence?: Record<string, unknown>;
    } | null;
  }>(
    `SELECT policy.state->>'status' AS policy_status, (policy.state->>'revision')::integer AS policy_revision,
            policy.last_stream_version AS policy_projection_version, stream.current_version::integer AS policy_stream_version,
            audit.status AS audit_status, audit.reason AS audit_reason, audit.last_stream_version AS audit_stream_version,
            audit.evidence AS audit_evidence, consent.result AS consent_result
     FROM (VALUES ($1::text, $2::text)) AS target(offer_id, policy_id)
     LEFT JOIN marketplace_buyer_offer_policy_pages AS policy ON policy.policy_id = target.policy_id
     LEFT JOIN event_store_streams AS stream ON stream.stream_id = 'marketplace.offer-policy-' || target.policy_id
     LEFT JOIN marketplace_managed_offer_audit AS audit ON audit.offer_id = target.offer_id
     LEFT JOIN LATERAL (
       SELECT selected.value->'result' AS result
       FROM event_store_events AS authorized
       CROSS JOIN LATERAL jsonb_array_elements(authorized.payload->'outcomes') AS selected(value)
       WHERE authorized.stream_id = 'marketplace.offer-policy-' || target.policy_id
         AND authorized.event_type = 'marketplace.offer-policy.authorized'
         AND authorized.payload->>'revision' = policy.state->>'revision'
         AND selected.value->>'offerId' = target.offer_id
       ORDER BY authorized.stream_version DESC LIMIT 1
     ) AS consent ON TRUE`,
    [offerId, policyId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Managed Offer authority snapshot missing.");
  return {
    policy: {
      status: row.policy_status,
      revision: row.policy_revision,
      projectionVersion: row.policy_projection_version,
      streamVersion: row.policy_stream_version,
    },
    audit: {
      status: row.audit_status,
      reason: row.audit_reason,
      streamVersion: row.audit_stream_version,
      ...pricingEvidence(row.audit_evidence),
    },
    consent: {
      status: row.consent_result?.status ?? null,
      reason: row.consent_result?.reason ?? null,
      amount: row.consent_result?.unitItemAmount ?? null,
      ...pricingEvidence(row.consent_result?.evidence ?? null),
    },
  };
}

export function managedOfferFulfillmentSnapshot(match: Readonly<Record<string, unknown>>) {
  return {
    can_fulfill: match.can_fulfill ?? null,
    managed_status: match.managed_status ?? null,
    seller_listing_availability_status: match.seller_listing_availability_status ?? null,
    status: match.status ?? null,
    seller_available_quantity: match.seller_available_quantity ?? null,
    quantity_requested: match.quantity_requested ?? null,
    price_amount: match.price_amount ?? null,
    listing_id: match.listing_id ?? null,
    last_stream_version: match.last_stream_version ?? null,
    listing_stream_version: match.listing_stream_version ?? null,
    listing_quantity_cap: match.listing_quantity_cap ?? null,
    listing_visible_quantity: match.listing_visible_quantity ?? null,
  };
}

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
            ? {
                marketPrice: "marketPrice" in evidence ? (evidence.marketPrice ?? null) : null,
                evaluatedAt: "evaluatedAt" in evidence ? (evidence.evaluatedAt ?? null) : null,
              }
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
