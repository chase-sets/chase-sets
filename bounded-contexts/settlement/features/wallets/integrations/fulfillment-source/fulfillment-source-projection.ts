import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, LedgerEntryId, OrderId } from "@chase-sets/primitives/typed-ids";
import type { WalletServices } from "../../api/runtime";
import { normalizeCurrencyCode } from "../../../../support/runtime-support/common";

type ReturnPostageWallets = Pick<WalletServices, "loadWalletState" | "postEntry">;

function eventContext(event: Readonly<Record<string, unknown>>): EventStoreContext {
  return {
    tenantId: event.tenantId as EventStoreContext["tenantId"],
    audit: event.audit as EventStoreContext["audit"],
    trace: event.trace as EventStoreContext["trace"],
  };
}

async function postOnce(
  wallets: ReturnPostageWallets | undefined,
  params: Parameters<WalletServices["postEntry"]>[0],
  event: Readonly<Record<string, unknown>>,
) {
  if (!wallets) return;
  const state = await wallets.loadWalletState(params.accountId);
  if (state.entries.some((entry) => entry.ledgerEntryId === params.ledgerEntryId)) return;
  await wallets.postEntry(params, eventContext(event));
}

export function buildSettlementFulfillmentSourceProjectionHandlers(
  db: PgQueryable,
  wallets?: ReturnPostageWallets,
): ProjectorHandlerMap {
  return {
    "fulfillment.return-shipment.requested.v2": async (event) => {
      const data = event.data as {
        returnShipmentId: string;
        supportRequestId: string;
        orderId: string;
        costPayer: string;
        requestedAt: string;
      };
      const seller = await db.query<{ seller_account_id: string }>(
        `SELECT seller_account_id
         FROM settlement_order_fulfillment_sources
         WHERE order_id = $1
         ORDER BY created_at ASC, shipment_id ASC
         LIMIT 1`,
        [data.orderId],
      );
      const sellerAccountId = seller.rows[0]?.seller_account_id;
      if (!sellerAccountId) return;
      await db.query(
        `INSERT INTO settlement_return_label_sources (
           return_shipment_id, support_request_id, order_id, seller_account_id, cost_payer, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (return_shipment_id) DO NOTHING`,
        [data.returnShipmentId, data.supportRequestId, data.orderId, sellerAccountId, data.costPayer, data.requestedAt],
      );
    },
    "fulfillment.return-shipment.label-ready.v1": async (event) => {
      const data = event.data as {
        returnShipmentId: string;
        postageAmountCents: number | null;
        postageCurrency: string | null;
        readyAt: string;
      };
      const amount = ((data.postageAmountCents ?? 0) / 100).toFixed(2);
      const updated = await db.query<{
        seller_account_id: string;
        order_id: string;
        cost_payer: string;
      }>(
        `UPDATE settlement_return_label_sources
         SET postage_amount = $2::numeric,
             currency_code = $3,
             label_status = 'ready',
             updated_at = $4
         WHERE return_shipment_id = $1
         RETURNING seller_account_id, order_id, cost_payer`,
        [data.returnShipmentId, amount, data.postageCurrency ?? "usd", data.readyAt],
      );
      const source = updated.rows[0];
      if (!source || source.cost_payer !== "seller" || amount === "0.00") return;
      await postOnce(
        wallets,
        {
          accountId: source.seller_account_id as AccountId,
          ledgerEntryId: `led_return_postage_${data.returnShipmentId}` as LedgerEntryId,
          kind: "fee",
          direction: "debit",
          amount,
          currencyCode: normalizeCurrencyCode(data.postageCurrency ?? "usd"),
          fundsStatus: "available",
          orderId: source.order_id as OrderId,
          description: "Seller-funded return postage",
          postedAt: data.readyAt,
          allowNegativeBalance: true,
        },
        event as never,
      );
    },
    "fulfillment.return-shipment.label-voided.v1": async (event) => {
      const data = event.data as { returnShipmentId: string; refundStatus: string; voidedAt: string };
      if (data.refundStatus.trim().toLowerCase() !== "refunded") return;
      const updated = await db.query<{
        seller_account_id: string;
        order_id: string;
        cost_payer: string;
        postage_amount: string;
        currency_code: string | null;
      }>(
        `UPDATE settlement_return_label_sources
         SET label_status = 'voided', updated_at = $2
         WHERE return_shipment_id = $1
         RETURNING seller_account_id, order_id, cost_payer, postage_amount::text AS postage_amount, currency_code`,
        [data.returnShipmentId, data.voidedAt],
      );
      const source = updated.rows[0];
      if (!source || source.cost_payer !== "seller" || source.postage_amount === "0.00") return;
      await postOnce(
        wallets,
        {
          accountId: source.seller_account_id as AccountId,
          ledgerEntryId: `led_return_postage_refund_${data.returnShipmentId}` as LedgerEntryId,
          kind: "fee",
          direction: "credit",
          amount: source.postage_amount,
          currencyCode: normalizeCurrencyCode(source.currency_code ?? "usd"),
          fundsStatus: "available",
          orderId: source.order_id as OrderId,
          description: "Carrier-refunded return postage",
          postedAt: data.voidedAt,
        },
        event as never,
      );
    },
    "fulfillment.shipment.created": async (event) => {
      const data = event.data as {
        shipmentId: string;
        orderId: string;
        buyerAccountId: string;
        sellerAccountId: string;
        trackingIdentifier?: string | null;
        createdAt: string;
      };

      await db.query(
        `INSERT INTO settlement_order_fulfillment_sources (
           shipment_id,
           order_id,
           buyer_account_id,
           seller_account_id,
           status,
           tracking_identifier,
           created_at,
           updated_at,
           dispatched_at,
           delivered_at,
           returned_at,
           exception_raised_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, 'created', $5, $6, $6, NULL, NULL, NULL, NULL, $7)
         ON CONFLICT (shipment_id) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           buyer_account_id = EXCLUDED.buyer_account_id,
           seller_account_id = EXCLUDED.seller_account_id,
           status = EXCLUDED.status,
           tracking_identifier = EXCLUDED.tracking_identifier,
           updated_at = EXCLUDED.updated_at,
           last_stream_version = EXCLUDED.last_stream_version
         WHERE settlement_order_fulfillment_sources.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.shipmentId,
          data.orderId,
          data.buyerAccountId,
          data.sellerAccountId,
          data.trackingIdentifier ?? null,
          data.createdAt,
          event.streamVersion,
        ],
      );
    },
    "fulfillment.shipment.dispatched": async (event) => {
      const data = event.data as { shipmentId: string; dispatchedAt: string };
      await db.query(
        `UPDATE settlement_order_fulfillment_sources
         SET status = 'dispatched',
             dispatched_at = $2,
             updated_at = $2,
             last_stream_version = $3
         WHERE shipment_id = $1
           AND last_stream_version < $3`,
        [data.shipmentId, data.dispatchedAt, event.streamVersion],
      );
    },
    "fulfillment.shipment.delivered": async (event) => {
      const data = event.data as { shipmentId: string; trackingIdentifier?: string | null; deliveredAt: string };
      await db.query(
        `UPDATE settlement_order_fulfillment_sources
         SET status = 'delivered',
             tracking_identifier = COALESCE($2, tracking_identifier),
             delivered_at = $3,
             updated_at = $3,
             last_stream_version = $4
         WHERE shipment_id = $1
           AND last_stream_version < $4`,
        [data.shipmentId, data.trackingIdentifier ?? null, data.deliveredAt, event.streamVersion],
      );
    },
    "fulfillment.shipment.returned": async (event) => {
      const data = event.data as { shipmentId: string; returnedAt: string };
      await db.query(
        `UPDATE settlement_order_fulfillment_sources
         SET status = 'returned',
             returned_at = $2,
             updated_at = $2,
             last_stream_version = $3
         WHERE shipment_id = $1
           AND last_stream_version < $3`,
        [data.shipmentId, data.returnedAt, event.streamVersion],
      );
    },
    "fulfillment.shipment.exception-raised": async (event) => {
      const data = event.data as { shipmentId: string; raisedAt: string };
      await db.query(
        `UPDATE settlement_order_fulfillment_sources
         SET status = 'exception',
             exception_raised_at = $2,
             updated_at = $2,
             last_stream_version = $3
         WHERE shipment_id = $1
           AND last_stream_version < $3`,
        [data.shipmentId, data.raisedAt, event.streamVersion],
      );
    },
  };
}
