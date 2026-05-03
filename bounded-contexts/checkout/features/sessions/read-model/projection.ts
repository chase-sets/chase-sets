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
        shippingOption: string;
        lines: unknown;
        createdAt: string;
      };

      await db.query(
        `INSERT INTO checkout_session_pages (
           session_id,
           buyer_account_id,
           source_type,
           shipping_option,
           shipping_address,
           lines,
           order_ids,
           payment_id,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, NULL, $5, '[]'::jsonb, NULL, $6, $6)
         ON CONFLICT (session_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             source_type = EXCLUDED.source_type,
             shipping_option = EXCLUDED.shipping_option,
             shipping_address = EXCLUDED.shipping_address,
             lines = EXCLUDED.lines,
             updated_at = EXCLUDED.updated_at`,
        [
          data.sessionId,
          data.buyerAccountId,
          data.sourceType,
          data.shippingOption,
          JSON.stringify(Array.isArray(data.lines) ? data.lines : []),
          data.createdAt,
        ],
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
