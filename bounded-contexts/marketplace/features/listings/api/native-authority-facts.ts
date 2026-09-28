import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  evolvePolicyDocument,
  initialPolicyDocumentState,
  type PolicyDocumentEvent,
} from "@chase-sets/platform-policy/domain";
import {
  LISTING_EVIDENCE_POLICY_KEY,
  LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
  decodeListingEvidencePolicyValue,
} from "../../listing-evidence-policy/domain/policy";

export const nativeAuthorityResources = {
  listing: (id: string) => `listing/${id}`,
  availability: (id: string) => `seller-availability/${id}`,
  reviews: (id: string) => `seller-reviews/${id}`,
  reviewOrder: (id: string) => `review-order/${id}`,
  policy: `policy/${LISTING_EVIDENCE_POLICY_KEY}`,
};

/** All queries here read Marketplace's own authoritative history, never read-model tables. */
export function createNativeAuthorityFacts(eventStore: EventStore, db: PgQueryable) {
  async function evidencePolicy(at: string) {
    const selected = await db.query<{ stream_id: string }>(
      `
      WITH documents AS (
        SELECT created.stream_id, latest.payload
        FROM event_store_events created CROSS JOIN LATERAL (
          SELECT payload FROM event_store_events WHERE stream_id = created.stream_id
          ORDER BY stream_version DESC LIMIT 1
        ) latest
        WHERE created.event_type = 'platform-policy.document.created'
          AND created.payload->>'policyKey' = $1 AND latest.payload->>'status' = 'active'
          AND (latest.payload->>'effectiveUntil' IS NULL OR (latest.payload->>'effectiveUntil')::timestamptz > $2::timestamptz)
      ), ranked AS (
        SELECT *, (payload->>'effectiveFrom')::timestamptz <= $2::timestamptz AS current,
          row_number() OVER (PARTITION BY ((payload->>'effectiveFrom')::timestamptz <= $2::timestamptz)
            ORDER BY (payload->>'effectiveFrom')::timestamptz, stream_id) AS ordinal
        FROM documents
      ) SELECT stream_id FROM ranked WHERE (current AND ordinal <= 2) OR (NOT current AND ordinal = 1)`,
      [LISTING_EVIDENCE_POLICY_KEY, at],
    );
    if (selected.rows.length > 3) throw new Error("Evidence policy selector exceeded its bound.");
    const documents = await Promise.all(
      selected.rows.map(async ({ stream_id: streamId }) => {
        const history = await readCompleteStream(eventStore, { streamId });
        const state = history.reduce(
          (state, event) =>
            evolvePolicyDocument(state, { type: event.eventType, data: event.payload } as PolicyDocumentEvent),
          initialPolicyDocumentState,
        );
        if (state.policyKey !== LISTING_EVIDENCE_POLICY_KEY || state.status !== "active")
          throw new Error("Evidence policy authority changed during selection.");
        return { streamId, state, revision: history.at(-1)?.streamVersion ?? 0 };
      }),
    );
    const active = documents.filter(
      ({ state }) =>
        state.effectiveFrom &&
        Date.parse(state.effectiveFrom) <= Date.parse(at) &&
        (!state.effectiveUntil || Date.parse(state.effectiveUntil) > Date.parse(at)),
    );
    if (active.length > 1) throw new Error("Overlapping active Listing Evidence Policies.");
    const chosen = active[0];
    return {
      documents,
      value: chosen ? decodeListingEvidencePolicyValue(chosen.state.value) : LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
      metadata: {
        policyId: chosen?.state.documentId ?? null,
        policyVersion: chosen?.revision ?? null,
        effectiveFrom: chosen?.state.effectiveFrom ?? null,
        effectiveUntil: chosen?.state.effectiveUntil ?? null,
      },
      boundaries: documents.flatMap(({ state }) => [state.effectiveFrom, state.effectiveUntil]),
    };
  }

  async function sellerReviewCount(accountId: string) {
    const result = await db.query<{ review_count: string }>(
      `
      SELECT COUNT(*)::text AS review_count FROM event_store_events submitted
      LEFT JOIN LATERAL (
        SELECT payload FROM event_store_events
        WHERE stream_id = 'marketplace.review-hold-' || (submitted.payload->>'orderId')
        ORDER BY stream_version DESC LIMIT 1
      ) hold ON true
      LEFT JOIN LATERAL (
        SELECT payload FROM event_store_events
        WHERE stream_id = 'marketplace.review-scoring-' || (submitted.payload->>'orderId')
        ORDER BY stream_version DESC LIMIT 1
      ) scoring ON true
      WHERE submitted.event_type = 'marketplace.review.submitted'
        AND submitted.payload->>'subjectAccountId' = $1 AND submitted.payload->>'authorRole' = 'buyer'
        AND (submitted.payload->>'reviewWindowExpiresAt' IS NULL OR EXISTS (
          SELECT 1 FROM event_store_events revealed WHERE revealed.stream_id = submitted.stream_id
            AND revealed.event_type = 'marketplace.review.revealed'))
        AND NOT EXISTS (SELECT 1 FROM event_store_events withdrawn WHERE withdrawn.stream_id = submitted.stream_id
          AND withdrawn.event_type = 'marketplace.review.withdrawn')
        AND NOT COALESCE(hold.payload->'heldDirections' ? 'buyer-to-seller', false)
        AND COALESCE(scoring.payload->'buyerToSeller'->>'scoringDisposition', submitted.payload->>'scoringDisposition', 'included') = 'included'`,
      [accountId],
    );
    const count = Number(result.rows[0]?.review_count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Seller review authority is unavailable.");
    return count;
  }

  async function writerResources(inputs: readonly AppendToStreamInput[]) {
    const scopes = new Set<string>();
    const orders = new Set<string>();
    for (const input of inputs) {
      if (!input.events.length) continue;
      if (input.streamId.startsWith("marketplace.listing-"))
        scopes.add(nativeAuthorityResources.listing(input.streamId.slice("marketplace.listing-".length)));
      if (input.streamId.startsWith("marketplace.seller-listing-availability-"))
        scopes.add(
          nativeAuthorityResources.availability(
            input.streamId.slice("marketplace.seller-listing-availability-".length),
          ),
        );
      if (input.events.some((event) => event.eventType.startsWith("platform-policy.document."))) {
        const history = await readCompleteStream(eventStore, { streamId: input.streamId });
        if ([...history, ...input.events].some((event) => event.payload.policyKey === LISTING_EVIDENCE_POLICY_KEY))
          scopes.add(nativeAuthorityResources.policy);
      }
      if (input.events.some((event) => event.eventType.startsWith("marketplace.review."))) {
        const history = await readCompleteStream(eventStore, { streamId: input.streamId });
        const submission = [...history, ...input.events].find(
          (event) => event.eventType === "marketplace.review.submitted",
        );
        if (
          !submission ||
          typeof submission.payload.orderId !== "string" ||
          typeof submission.payload.subjectAccountId !== "string"
        )
          throw new Error("Review writer lacks authoritative subject identity.");
        orders.add(submission.payload.orderId);
        if (submission.payload.authorRole === "buyer")
          scopes.add(nativeAuthorityResources.reviews(submission.payload.subjectAccountId));
      }
      for (const event of input.events) {
        if (
          event.eventType.startsWith("marketplace.review-hold.") ||
          event.eventType.startsWith("marketplace.review-scoring.")
        ) {
          if (typeof event.payload.orderId !== "string") throw new Error("Review disposition lacks order identity.");
          orders.add(event.payload.orderId);
        }
      }
    }
    if (orders.size) {
      for (const order of orders) scopes.add(nativeAuthorityResources.reviewOrder(order));
      const subjects = await db.query<{ account_id: string }>(
        `
        SELECT DISTINCT payload->>'subjectAccountId' AS account_id FROM event_store_events
        WHERE event_type = 'marketplace.review.submitted' AND payload->>'authorRole' = 'buyer'
          AND payload->>'orderId' = ANY($1::text[])`,
        [[...orders]],
      );
      for (const row of subjects.rows) {
        if (!row.account_id) throw new Error("Review disposition has corrupt seller identity.");
        scopes.add(nativeAuthorityResources.reviews(row.account_id));
      }
    }
    return [...scopes];
  }
  return { evidencePolicy, sellerReviewCount, writerResources };
}
