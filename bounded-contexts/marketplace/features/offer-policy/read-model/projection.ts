import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { buyerOfferPolicyCodec } from "../domain/codec";
import { initialBuyerOfferPolicyState, type BuyerOfferPolicyState } from "../domain/domain";

export function buildBuyerOfferPolicyProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const policy: ProjectorHandlerMap[string] = async (event) => {
    const decoded = buyerOfferPolicyCodec.decode({ eventType: event.type, payload: event.data });
    const data = decoded.data;
    if (decoded.type === "marketplace.offer-policy.created") {
      await db.query(
        `INSERT INTO marketplace_buyer_offer_policy_pages (policy_id, buyer_account_id, state, last_stream_version)
        VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (policy_id) DO NOTHING`,
        [
          data.policyId,
          data.buyerAccountId,
          JSON.stringify({
            ...initialBuyerOfferPolicyState,
            policyId: data.policyId,
            buyerAccountId: data.buyerAccountId,
          }),
          event.streamVersion,
        ],
      );
      return;
    }
    let patch: Partial<BuyerOfferPolicyState>;
    switch (decoded.type) {
      case "marketplace.offer-policy.previewed":
        patch = {
          preview: {
            previewId: decoded.data.previewId,
            policyVersion: decoded.data.policyVersion,
            terms: decoded.data.terms,
          },
        };
        break;
      case "marketplace.offer-policy.authorized":
        patch = {
          status: "active",
          currency: decoded.data.terms.currency,
          authority: decoded.data.terms,
          revision: decoded.data.revision,
          preview: null,
        };
        break;
      case "marketplace.offer-policy.paused":
        patch = { status: "paused", preview: null };
        break;
      case "marketplace.offer-policy.stopped":
        patch = { status: "stopped", preview: null };
        break;
    }
    await db.query(
      `UPDATE marketplace_buyer_offer_policy_pages SET state = state || $2::jsonb, last_stream_version = $3
      WHERE policy_id = $1 AND last_stream_version < $3`,
      [data.policyId, JSON.stringify(patch), event.streamVersion],
    );
  };
  return {
    "marketplace.offer-policy.created": policy,
    "marketplace.offer-policy.previewed": policy,
    "marketplace.offer-policy.authorized": policy,
    "marketplace.offer-policy.paused": policy,
    "marketplace.offer-policy.stopped": policy,
    "marketplace.offer.buyer-policy-bound": async (event) => {
      await db.query(
        `INSERT INTO marketplace_buyer_offer_policy_memberships (offer_id, policy_id, buyer_account_id)
        VALUES ($1, $2, $3) ON CONFLICT (offer_id) DO NOTHING`,
        [event.data.offerId, event.data.policyId, event.data.buyerAccountId],
      );
    },
  };
}
