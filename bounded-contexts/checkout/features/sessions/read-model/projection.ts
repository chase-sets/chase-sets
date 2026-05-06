import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildCheckoutSessionProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "checkout.session.started": async (event) => {
      const data = event.data as {
        sessionId: string;
        buyerAccountId: string;
        sourceType: string;
        optimizationGoal?: string;
        fulfillmentPreviewRevision?: string | null;
        shippingOption: string;
        lines: unknown;
        createdAt: string;
      };

      await db.query(
        `INSERT INTO checkout_session_pages (
           session_id,
           buyer_account_id,
           source_type,
           optimization_goal,
           fulfillment_preview_revision,
           shipping_option,
           shipping_address,
           lines,
           order_ids,
           payment_id,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, '[]'::jsonb, NULL, $8, $8)
         ON CONFLICT (session_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             source_type = EXCLUDED.source_type,
             optimization_goal = EXCLUDED.optimization_goal,
             fulfillment_preview_revision = EXCLUDED.fulfillment_preview_revision,
             shipping_option = EXCLUDED.shipping_option,
             shipping_address = EXCLUDED.shipping_address,
             lines = EXCLUDED.lines,
             updated_at = EXCLUDED.updated_at`,
        [
          data.sessionId,
          data.buyerAccountId,
          data.sourceType,
          data.optimizationGoal === "fewest-shipments" ? "fewest-shipments" : "lowest-total",
          data.fulfillmentPreviewRevision ?? null,
          data.shippingOption,
          JSON.stringify(Array.isArray(data.lines) ? data.lines : []),
          data.createdAt,
        ],
      );
    },
    "checkout.session.optimization-goal-selected": async (event) => {
      const data = event.data as {
        sessionId: string;
        optimizationGoal: string;
        selectedAt: string;
      };

      await db.query(
        `UPDATE checkout_session_pages
         SET optimization_goal = $2,
             fulfillment_preview_revision = NULL,
             updated_at = $3
         WHERE session_id = $1`,
        [
          data.sessionId,
          data.optimizationGoal === "fewest-shipments" ? "fewest-shipments" : "lowest-total",
          data.selectedAt,
        ],
      );
    },
    "checkout.session.fulfillment-preview-recorded": async (event) => {
      const data = event.data as {
        sessionId: string;
        fulfillmentPreviewRevision: string;
        recordedAt: string;
      };

      await db.query(
        `UPDATE checkout_session_pages
         SET fulfillment_preview_revision = $2,
             updated_at = $3
         WHERE session_id = $1`,
        [data.sessionId, data.fulfillmentPreviewRevision, data.recordedAt],
      );
    },
    "checkout.session.shipping-option-selected": async (event) => {
      const data = event.data as {
        sessionId: string;
        shippingOption: string;
        selectedAt: string;
      };

      await db.query(
        `UPDATE checkout_session_pages
         SET shipping_option = $2,
             updated_at = $3
         WHERE session_id = $1`,
        [data.sessionId, data.shippingOption, data.selectedAt],
      );
    },
    "checkout.session.shipping-address-set": async (event) => {
      const data = event.data as {
        sessionId: string;
        shippingAddress: unknown;
        selectedAt: string;
      };

      await db.query(
        `UPDATE checkout_session_pages
         SET shipping_address = $2,
             updated_at = $3
         WHERE session_id = $1`,
        [data.sessionId, JSON.stringify(data.shippingAddress), data.selectedAt],
      );
    },
    "checkout.session.orders-created": async (event) => {
      const data = event.data as {
        sessionId: string;
        orderIds: string[];
        recordedAt: string;
      };

      await db.query(
        `UPDATE checkout_session_pages
         SET order_ids = $2,
             updated_at = $3
         WHERE session_id = $1`,
        [data.sessionId, JSON.stringify(data.orderIds), data.recordedAt],
      );
    },
    "checkout.session.payment-started": async (event) => {
      const data = event.data as {
        sessionId: string;
        paymentId: string;
        recordedAt: string;
      };

      await db.query(
        `UPDATE checkout_session_pages
         SET payment_id = $2,
             updated_at = $3
         WHERE session_id = $1`,
        [data.sessionId, data.paymentId, data.recordedAt],
      );
    },
  };
}
