import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

const refundResolutionTypes = new Set(["full-refund", "partial-refund", "return-for-refund", "cancel-order"]);

export function createSettlementSupportHoldId(supportRequestId: string): string {
  return `hold_${supportRequestId.replace(/^sup_/, "")}`;
}

function fraudHoldSourceId(params: Readonly<{ sourceId: string; orderId: string; sellerAccountId: string }>) {
  const raw = `fraud_${params.sourceId}_${params.orderId}_${params.sellerAccountId}`;
  return raw.replaceAll(/[^a-zA-Z0-9_]+/g, "_").replaceAll(/^_+|_+$/g, "");
}

async function insertFraudHolds(
  db: PgQueryable,
  params: Readonly<{
    sourceId: string;
    orderIds: readonly string[];
    buyerAccountId: string;
    sellerPayouts: readonly Readonly<{ orderId: string; sellerAccountId: string }>[];
    flowType: string;
    status: string;
    openedAt: string;
    streamVersion: number;
  }>,
) {
  const orderIds = new Set(params.orderIds);
  const sellerPayouts = params.sellerPayouts.filter((payout) => orderIds.has(payout.orderId));

  for (const payout of sellerPayouts) {
    const sourceId = fraudHoldSourceId({
      sourceId: params.sourceId,
      orderId: payout.orderId,
      sellerAccountId: payout.sellerAccountId,
    });
    await db.query(
      `INSERT INTO settlement_support_holds (
         support_request_id,
         hold_id,
         order_id,
         buyer_account_id,
         seller_account_id,
         flow_type,
         status,
         resolution_type,
         active,
         opened_at,
         updated_at,
         released_at,
         release_reason,
         last_stream_version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, TRUE, $8, $8, NULL, NULL, $9)
       ON CONFLICT (support_request_id) DO UPDATE
       SET hold_id = EXCLUDED.hold_id,
           order_id = EXCLUDED.order_id,
           buyer_account_id = EXCLUDED.buyer_account_id,
           seller_account_id = EXCLUDED.seller_account_id,
           flow_type = EXCLUDED.flow_type,
           status = EXCLUDED.status,
           active = TRUE,
           updated_at = EXCLUDED.updated_at,
           released_at = NULL,
           release_reason = NULL,
           last_stream_version = EXCLUDED.last_stream_version
       WHERE settlement_support_holds.last_stream_version < EXCLUDED.last_stream_version`,
      [
        sourceId,
        createSettlementSupportHoldId(sourceId),
        payout.orderId,
        params.buyerAccountId,
        payout.sellerAccountId,
        params.flowType,
        params.status,
        params.openedAt,
        params.streamVersion,
      ],
    );
  }
}

async function releaseFraudReviewHolds(
  db: PgQueryable,
  params: Readonly<{ providerReviewId: string; releasedAt: string; streamVersion: number }>,
) {
  const sourcePrefix = fraudHoldSourceId({ sourceId: params.providerReviewId, orderId: "", sellerAccountId: "" });
  await db.query(
    `UPDATE settlement_support_holds
     SET status = 'closed',
         active = FALSE,
         updated_at = $2,
         released_at = $2,
         release_reason = 'stripe-review-approved',
         last_stream_version = $3
     WHERE support_request_id LIKE $1
       AND flow_type = 'stripe-radar-review'
       AND last_stream_version < $3`,
    [`${sourcePrefix}%`, params.releasedAt, params.streamVersion],
  );
}

async function releaseChargebackHolds(
  db: PgQueryable,
  params: Readonly<{ providerDisputeId: string; releasedAt: string; streamVersion: number }>,
) {
  const sourcePrefix = fraudHoldSourceId({ sourceId: params.providerDisputeId, orderId: "", sellerAccountId: "" });
  await db.query(
    `UPDATE settlement_support_holds
     SET status = 'won',
         active = FALSE,
         updated_at = $2,
         released_at = $2,
         release_reason = 'stripe-chargeback-won',
         last_stream_version = $3
     WHERE support_request_id LIKE $1
       AND flow_type = 'stripe-chargeback'
       AND last_stream_version < $3`,
    [`${sourcePrefix}%`, params.releasedAt, params.streamVersion],
  );
}

export function buildSettlementSupportHoldProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "support.support-request.opened": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        orderId: string;
        buyerAccountId: string;
        sellerAccountId: string;
        flowType: string;
        status: string;
        openedAt: string;
      };

      await db.query(
        `INSERT INTO settlement_support_holds (
           support_request_id,
           hold_id,
           order_id,
           buyer_account_id,
           seller_account_id,
           flow_type,
           status,
           resolution_type,
           active,
           opened_at,
           updated_at,
           released_at,
           release_reason,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, TRUE, $8, $8, NULL, NULL, $9)
         ON CONFLICT (support_request_id) DO UPDATE
         SET hold_id = EXCLUDED.hold_id,
             order_id = EXCLUDED.order_id,
             buyer_account_id = EXCLUDED.buyer_account_id,
             seller_account_id = EXCLUDED.seller_account_id,
             flow_type = EXCLUDED.flow_type,
             status = EXCLUDED.status,
             active = TRUE,
             updated_at = EXCLUDED.updated_at,
             released_at = NULL,
             release_reason = NULL,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE settlement_support_holds.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.supportRequestId,
          createSettlementSupportHoldId(data.supportRequestId),
          data.orderId,
          data.buyerAccountId,
          data.sellerAccountId,
          data.flowType,
          data.status,
          data.openedAt,
          event.streamVersion,
        ],
      );
    },
    "support.support-request.escalated": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        escalatedAt: string;
      };

      await db.query(
        `UPDATE settlement_support_holds
         SET status = 'ready-for-support',
             updated_at = $2,
             last_stream_version = $3
         WHERE support_request_id = $1
           AND last_stream_version < $3`,
        [data.supportRequestId, data.escalatedAt, event.streamVersion],
      );
    },
    "support.support-request.resolved": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        resolution: {
          resolutionType: string;
          resolvedAt: string;
        };
      };
      const keepHold = refundResolutionTypes.has(data.resolution.resolutionType);

      await db.query(
        `UPDATE settlement_support_holds
         SET status = 'resolved',
             resolution_type = $2,
             active = $3,
             updated_at = $4,
             released_at = CASE WHEN $3 THEN released_at ELSE $4 END,
             release_reason = CASE WHEN $3 THEN release_reason ELSE 'support-resolved' END,
             last_stream_version = $5
         WHERE support_request_id = $1
           AND last_stream_version < $5`,
        [
          data.supportRequestId,
          data.resolution.resolutionType,
          keepHold,
          data.resolution.resolvedAt,
          event.streamVersion,
        ],
      );
    },
    "support.support-request.closed": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        closedAt: string;
      };

      await db.query(
        `UPDATE settlement_support_holds
         SET status = 'closed',
             active = CASE
               WHEN resolution_type IN ('full-refund', 'partial-refund', 'return-for-refund', 'cancel-order') THEN active
               ELSE FALSE
             END,
             updated_at = $2,
             released_at = CASE
               WHEN resolution_type IN ('full-refund', 'partial-refund', 'return-for-refund', 'cancel-order') THEN released_at
               ELSE $2
             END,
             release_reason = CASE
               WHEN resolution_type IN ('full-refund', 'partial-refund', 'return-for-refund', 'cancel-order') THEN release_reason
               ELSE 'support-closed'
             END,
             last_stream_version = $3
         WHERE support_request_id = $1
           AND last_stream_version < $3`,
        [data.supportRequestId, data.closedAt, event.streamVersion],
      );
    },
    "support.support-request.cancelled": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        cancelledAt: string;
      };

      await db.query(
        `UPDATE settlement_support_holds
         SET status = 'cancelled',
             active = FALSE,
             updated_at = $2,
             released_at = $2,
             release_reason = 'support-cancelled',
             last_stream_version = $3
         WHERE support_request_id = $1
           AND last_stream_version < $3`,
        [data.supportRequestId, data.cancelledAt, event.streamVersion],
      );
    },
    "settlement.protection-coverage.settled.v1": async (event) => {
      // The correlated support hold releases only after Settlement's own allocation
      // reconciliation is durable: the ProtectionCoverage aggregate emits this fact
      // after the seller and platform postings are committed (ADR 0022, #5220), never
      // merely because Payments reported a refund. Keyed by supportRequestId, released
      // exactly once.
      const data = event.data as {
        supportRequestId: string;
        occurredAt: string;
      };

      await db.query(
        `UPDATE settlement_support_holds
         SET status = 'reconciled',
             active = FALSE,
             updated_at = $2,
             released_at = $2,
             release_reason = 'coverage-reconciled',
             last_stream_version = $3
         WHERE support_request_id = $1
           AND last_stream_version < $3`,
        [data.supportRequestId, data.occurredAt, event.streamVersion],
      );
    },
    "payments.payment-fraud-warning-received": async (event) => {
      const data = event.data as {
        orderIds: string[];
        buyerAccountId: string;
        sellerPayouts: readonly Readonly<{ orderId: string; sellerAccountId: string }>[];
        earlyFraudWarningId: string;
        receivedAt: string;
      };
      await insertFraudHolds(db, {
        sourceId: data.earlyFraudWarningId,
        orderIds: data.orderIds,
        buyerAccountId: data.buyerAccountId,
        sellerPayouts: data.sellerPayouts,
        flowType: "stripe-early-fraud-warning",
        status: "opened",
        openedAt: data.receivedAt,
        streamVersion: event.streamVersion,
      });
    },
    "payments.payment-fraud-review-opened": async (event) => {
      const data = event.data as {
        orderIds: string[];
        buyerAccountId: string;
        sellerPayouts: readonly Readonly<{ orderId: string; sellerAccountId: string }>[];
        providerReviewId: string;
        openedAt: string;
      };
      await insertFraudHolds(db, {
        sourceId: data.providerReviewId,
        orderIds: data.orderIds,
        buyerAccountId: data.buyerAccountId,
        sellerPayouts: data.sellerPayouts,
        flowType: "stripe-radar-review",
        status: "opened",
        openedAt: data.openedAt,
        streamVersion: event.streamVersion,
      });
    },
    "payments.payment-fraud-review-closed": async (event) => {
      const data = event.data as {
        providerReviewId: string;
        outcome: string | null;
        closedAt: string;
      };
      if (data.outcome === "approved") {
        await releaseFraudReviewHolds(db, {
          providerReviewId: data.providerReviewId,
          releasedAt: data.closedAt,
          streamVersion: event.streamVersion,
        });
      }
    },
    "payments.payment-disputed": async (event) => {
      const data = event.data as {
        orderIds: string[];
        buyerAccountId: string;
        sellerPayouts: readonly Readonly<{ orderId: string; sellerAccountId: string }>[];
        paymentId?: string | null;
        providerDisputeId?: string | null;
        disputeLifecycleState: string;
        disputedAt: string;
      };
      const providerDisputeId = data.providerDisputeId ?? data.paymentId ?? event.id;
      if (data.disputeLifecycleState === "won") {
        await releaseChargebackHolds(db, {
          providerDisputeId,
          releasedAt: data.disputedAt,
          streamVersion: event.streamVersion,
        });
        return;
      }
      await insertFraudHolds(db, {
        sourceId: providerDisputeId,
        orderIds: data.orderIds,
        buyerAccountId: data.buyerAccountId,
        sellerPayouts: data.sellerPayouts,
        flowType: "stripe-chargeback",
        status: data.disputeLifecycleState,
        openedAt: data.disputedAt,
        streamVersion: event.streamVersion,
      });
    },
  };
}
