import { resolveProjectionDb, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildCheckoutSessionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "checkout.session.started": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as {
        sessionId: string;
        buyerAccountId: string;
        sourceType: string;
        optimizationGoal?: string;
        fulfillmentPreviewRevision?: string | null;
        fulfillmentPreviewSnapshot?: unknown;
        cartReadinessSnapshot?: unknown;
        splitGroupHandoff?: unknown;
        shippingOption: string;
        lines: unknown;
        createdAt: string;
      };

      await projectionDb.query(
        `INSERT INTO checkout_session_pages (
           session_id,
           buyer_account_id,
           source_type,
           optimization_goal,
           fulfillment_preview_revision,
           fulfillment_preview_snapshot,
           cart_readiness_snapshot,
           split_group_handoff,
           shipping_option,
           shipping_address_id,
           shipping_address,
           lines,
           order_ids,
           order_write_commit_positions,
           checkout_reservations,
           payment_id,
           submitted_offer_id,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, $10, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NULL, NULL, $11, $11)
         ON CONFLICT (session_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             source_type = EXCLUDED.source_type,
             optimization_goal = EXCLUDED.optimization_goal,
             fulfillment_preview_revision = EXCLUDED.fulfillment_preview_revision,
             fulfillment_preview_snapshot = EXCLUDED.fulfillment_preview_snapshot,
             cart_readiness_snapshot = EXCLUDED.cart_readiness_snapshot,
             split_group_handoff = EXCLUDED.split_group_handoff,
             shipping_option = EXCLUDED.shipping_option,
             shipping_address_id = EXCLUDED.shipping_address_id,
             shipping_address = EXCLUDED.shipping_address,
             lines = EXCLUDED.lines,
             updated_at = EXCLUDED.updated_at`,
        [
          data.sessionId,
          data.buyerAccountId,
          data.sourceType,
          data.optimizationGoal === "fewest-shipments" ? "fewest-shipments" : "lowest-total",
          data.fulfillmentPreviewRevision ?? null,
          JSON.stringify(data.fulfillmentPreviewSnapshot ?? null),
          JSON.stringify(data.cartReadinessSnapshot ?? null),
          JSON.stringify(data.splitGroupHandoff ?? null),
          data.shippingOption,
          JSON.stringify(Array.isArray(data.lines) ? data.lines : []),
          data.createdAt,
        ],
      );
    },
    "checkout.session.optimization-goal-selected": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as {
        sessionId: string;
        optimizationGoal: string;
        selectedAt: string;
      };

      await projectionDb.query(
        `UPDATE checkout_session_pages
         SET optimization_goal = $2,
             fulfillment_preview_revision = NULL,
             fulfillment_preview_snapshot = NULL,
             updated_at = $3
         WHERE session_id = $1`,
        [
          data.sessionId,
          data.optimizationGoal === "fewest-shipments" ? "fewest-shipments" : "lowest-total",
          data.selectedAt,
        ],
      );
    },
    "checkout.session.fulfillment-preview-recorded": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as {
        sessionId: string;
        fulfillmentPreviewRevision: string;
        fulfillmentPreviewSnapshot?: unknown;
        recordedAt: string;
      };

      await projectionDb.query(
        `UPDATE checkout_session_pages
         SET fulfillment_preview_revision = $2,
             fulfillment_preview_snapshot = $3,
             updated_at = $4
         WHERE session_id = $1`,
        [
          data.sessionId,
          data.fulfillmentPreviewRevision,
          JSON.stringify(data.fulfillmentPreviewSnapshot ?? null),
          data.recordedAt,
        ],
      );
    },
    "checkout.session.shipping-option-selected": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as {
        sessionId: string;
        shippingOption: string;
        selectedAt: string;
      };

      await projectionDb.query(
        `UPDATE checkout_session_pages
         SET shipping_option = $2,
             fulfillment_preview_revision = NULL,
             fulfillment_preview_snapshot = NULL,
             updated_at = $3
         WHERE session_id = $1`,
        [data.sessionId, data.shippingOption, data.selectedAt],
      );
    },
    "checkout.session.shipping-address-set": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as {
        sessionId: string;
        shippingAddress: { shippingAddressId?: string | null } | null;
        selectedAt: string;
      };

      await projectionDb.query(
        `UPDATE checkout_session_pages
         SET shipping_address_id = $2,
             shipping_address = $3,
             fulfillment_preview_revision = NULL,
             fulfillment_preview_snapshot = NULL,
             updated_at = $4
         WHERE session_id = $1`,
        [
          data.sessionId,
          data.shippingAddress?.shippingAddressId ?? null,
          JSON.stringify(data.shippingAddress),
          data.selectedAt,
        ],
      );
    },
    "checkout.session.orders-created": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as {
        sessionId: string;
        orderIds: string[];
        orderWriteCommitPositions?: unknown;
        recordedAt: string;
      };

      await projectionDb.query(
        `UPDATE checkout_session_pages
         SET order_ids = $2,
             order_write_commit_positions = $3,
             checkout_reservations = (
               SELECT COALESCE(jsonb_agg(reservation || jsonb_build_object('status', 'converted')), '[]'::jsonb)
               FROM jsonb_array_elements(checkout_reservations) AS reservation
             ),
             updated_at = $4
         WHERE session_id = $1`,
        [
          data.sessionId,
          JSON.stringify(data.orderIds),
          JSON.stringify(Array.isArray(data.orderWriteCommitPositions) ? data.orderWriteCommitPositions : []),
          data.recordedAt,
        ],
      );
    },
    "checkout.session.reservations-recorded": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as {
        sessionId: string;
        reservations: unknown;
        recordedAt: string;
      };

      await projectionDb.query(
        `UPDATE checkout_session_pages
         SET checkout_reservations = $2,
             updated_at = $3
         WHERE session_id = $1`,
        [data.sessionId, JSON.stringify(Array.isArray(data.reservations) ? data.reservations : []), data.recordedAt],
      );
    },
    "checkout.session.payment-started": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as {
        sessionId: string;
        paymentId: string;
        recordedAt: string;
      };

      await projectionDb.query(
        `UPDATE checkout_session_pages
         SET payment_id = $2,
             updated_at = $3
         WHERE session_id = $1`,
        [data.sessionId, data.paymentId, data.recordedAt],
      );
    },
    "checkout.session.offer-submitted": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as {
        sessionId: string;
        offerId: string;
        recordedAt: string;
      };

      await projectionDb.query(
        `UPDATE checkout_session_pages
         SET submitted_offer_id = $2,
             updated_at = $3
         WHERE session_id = $1`,
        [data.sessionId, data.offerId, data.recordedAt],
      );
    },
  };
}
