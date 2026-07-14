import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  SupportChecklistItem,
  SupportEvidence,
  SupportFlowType,
  SupportOffer,
  SupportResolution,
  SupportResponse,
} from "../domain/common";
import { normalizeSupportResolutionForReplay } from "../domain/responsibility";
import { withSupportRequestDisplayReference } from "./display-reference";
import type { SupportRequestId } from "@chase-sets/primitives/typed-ids";

export function buildSupportRequestProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "support.support-request.opened": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        orderId: string;
        buyerAccountId: string;
        sellerAccountId: string;
        flowType: string;
        status: string;
        priority: string;
        openedByAccountId: string;
        openedByRole: string;
        openedAt: string;
        sellerResponseDueAt: string | null;
        supportReviewDueAt: string | null;
        sellerConditionAttestationDueAt: string | null;
        orderReturnContext: unknown;
        returnInvestigation: unknown;
        checklist: readonly SupportChecklistItem[];
      };

      await withSupportRequestDisplayReference(data.supportRequestId as SupportRequestId, (displayReference) =>
        db.query(
          `INSERT INTO support_request_pages (
           support_request_id,
           order_id,
           buyer_account_id,
           seller_account_id,
           flow_type,
           status,
           priority,
           opened_by_account_id,
           opened_by_role,
           opened_at,
           updated_at,
           seller_response_due_at,
           support_review_due_at,
           seller_condition_attestation_due_at,
           order_return_context,
           return_investigation,
           checklist,
           evidence,
           responses,
           offers,
           pending_offer,
           resolution,
           closed_at,
           cancellation_reason,
           display_reference
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13,
           $14::jsonb, $15::jsonb, $16::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NULL, NULL, NULL, NULL, $17
         )
         ON CONFLICT (support_request_id) DO UPDATE
          SET status = EXCLUDED.status,
             priority = EXCLUDED.priority,
             updated_at = EXCLUDED.updated_at,
             seller_response_due_at = EXCLUDED.seller_response_due_at,
             support_review_due_at = EXCLUDED.support_review_due_at,
             seller_condition_attestation_due_at = EXCLUDED.seller_condition_attestation_due_at,
             order_return_context = EXCLUDED.order_return_context,
             return_investigation = EXCLUDED.return_investigation,
             checklist = EXCLUDED.checklist`,
          [
            data.supportRequestId,
            data.orderId,
            data.buyerAccountId,
            data.sellerAccountId,
            data.flowType,
            data.status,
            data.priority,
            data.openedByAccountId,
            data.openedByRole,
            data.openedAt,
            data.sellerResponseDueAt,
            data.supportReviewDueAt,
            data.sellerConditionAttestationDueAt,
            JSON.stringify(data.orderReturnContext ?? []),
            data.returnInvestigation ? JSON.stringify(data.returnInvestigation) : null,
            JSON.stringify(data.checklist),
            displayReference,
          ],
        ),
      );
    },
    "support.support-request.evidence-submitted": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        evidence: SupportEvidence;
        status: string;
        priority: string;
        sellerConditionAttestationDueAt: string | null;
        returnInvestigation: unknown;
        updatedChecklist: readonly SupportChecklistItem[];
      };

      await db.query(
        `UPDATE support_request_pages
         SET status = $2,
             priority = $3,
             updated_at = $4,
             seller_condition_attestation_due_at = $5,
             return_investigation = $6::jsonb,
             checklist = $7::jsonb,
             evidence = evidence || $8::jsonb
         WHERE support_request_id = $1`,
        [
          data.supportRequestId,
          data.status,
          data.priority,
          data.evidence.submittedAt,
          data.sellerConditionAttestationDueAt,
          data.returnInvestigation ? JSON.stringify(data.returnInvestigation) : null,
          JSON.stringify(data.updatedChecklist),
          JSON.stringify([data.evidence]),
        ],
      );
    },
    "support.support-request.affected-line-items-recorded": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        affectedLineItems: unknown;
      };

      await db.query(
        `UPDATE support_request_pages
         SET affected_line_items = $2::jsonb
         WHERE support_request_id = $1`,
        [data.supportRequestId, JSON.stringify(data.affectedLineItems ?? [])],
      );
    },
    "support.support-request.response-recorded": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        response: SupportResponse;
        offer: SupportOffer | null;
        status: string;
      };

      await db.query(
        `UPDATE support_request_pages
         SET status = $2,
             updated_at = $3,
             responses = responses || $4::jsonb,
             offers = CASE WHEN $5::jsonb IS NULL THEN offers ELSE offers || jsonb_build_array($5::jsonb) END,
             pending_offer = $5::jsonb
         WHERE support_request_id = $1`,
        [
          data.supportRequestId,
          data.status,
          data.response.submittedAt,
          JSON.stringify([data.response]),
          data.offer ? JSON.stringify(data.offer) : null,
        ],
      );
    },
    "support.support-request.offer-accepted": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        offer: SupportOffer;
      };

      await db.query(
        `UPDATE support_request_pages
         SET updated_at = $3,
             offers = COALESCE(
               (
                 SELECT jsonb_agg(CASE WHEN offer ->> 'offerId' = $2 THEN $4::jsonb ELSE offer END)
                 FROM jsonb_array_elements(offers) offer
               ),
               '[]'::jsonb
             ),
             pending_offer = NULL
         WHERE support_request_id = $1`,
        [data.supportRequestId, data.offer.offerId, data.offer.decidedAt, JSON.stringify(data.offer)],
      );
    },
    "support.support-request.offer-declined": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        offer: SupportOffer;
        status: string;
      };

      await db.query(
        `UPDATE support_request_pages
         SET status = $2,
             updated_at = $4,
             offers = COALESCE(
               (
                 SELECT jsonb_agg(CASE WHEN offer ->> 'offerId' = $3 THEN $5::jsonb ELSE offer END)
                 FROM jsonb_array_elements(offers) offer
               ),
               '[]'::jsonb
             ),
             pending_offer = NULL
         WHERE support_request_id = $1`,
        [data.supportRequestId, data.status, data.offer.offerId, data.offer.decidedAt, JSON.stringify(data.offer)],
      );
    },
    "support.support-request.escalated": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        escalatedAt: string;
        reason: string;
        escalatedByAccountId: string | null;
        escalatedByRole: string | null;
      };

      await db.query(
        `UPDATE support_request_pages
         SET status = 'ready-for-support',
             updated_at = $2,
             escalated_at = $2,
             escalated_by_account_id = $3,
             escalated_by_role = $4,
             escalation_reason = $5
         WHERE support_request_id = $1`,
        [data.supportRequestId, data.escalatedAt, data.escalatedByAccountId, data.escalatedByRole, data.reason],
      );
    },
    "support.support-request.resolved": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        flowType: SupportFlowType;
        resolution: SupportResolution;
        autoCloseDueAt: string;
      };
      const resolution = normalizeSupportResolutionForReplay(data.resolution, data.flowType);
      const returnRefundGateStatus =
        resolution.resolutionType === "return-for-refund" ? "awaiting-return-delivery" : null;

      await db.query(
        `UPDATE support_request_pages
         SET status = 'resolved',
             updated_at = $2,
             resolution = $3::jsonb,
             auto_close_due_at = $4,
             return_refund_gate_status = $5
         WHERE support_request_id = $1`,
        [
          data.supportRequestId,
          resolution.resolvedAt,
          JSON.stringify(resolution),
          data.autoCloseDueAt,
          returnRefundGateStatus,
        ],
      );
    },
    "support.support-request.closed": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        closedAt: string;
      };

      await db.query(
        `UPDATE support_request_pages
         SET status = 'closed',
             updated_at = $2,
             closed_at = $2
         WHERE support_request_id = $1`,
        [data.supportRequestId, data.closedAt],
      );
    },
    "support.support-request.cancelled": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        cancelledAt: string;
        reason: string;
      };

      await db.query(
        `UPDATE support_request_pages
         SET status = 'cancelled',
             updated_at = $2,
             closed_at = $2,
             cancellation_reason = $3
         WHERE support_request_id = $1`,
        [data.supportRequestId, data.cancelledAt, data.reason],
      );
    },
    "support.support-request.response-reminder-emitted": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        remindedAt: string;
      };

      await db.query(
        `UPDATE support_request_pages
         SET seller_response_reminder_sent_at = $2
         WHERE support_request_id = $1`,
        [data.supportRequestId, data.remindedAt],
      );
    },
    "support.support-request.review-reminder-emitted": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        remindedAt: string;
      };

      await db.query(
        `UPDATE support_request_pages
         SET support_review_reminder_sent_at = $2
         WHERE support_request_id = $1`,
        [data.supportRequestId, data.remindedAt],
      );
    },
    "support.support-request.return-delivered": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        deliveredAt: string;
        returnRefundReleaseDueAt: string;
      };

      await db.query(
        `UPDATE support_request_pages
         SET return_refund_gate_status = 'awaiting-return-inspection',
             return_delivered_at = $2,
             return_refund_release_due_at = $3
         WHERE support_request_id = $1`,
        [data.supportRequestId, data.deliveredAt, data.returnRefundReleaseDueAt],
      );
    },
    "support.support-request.return-condition-disputed": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        disputedAt: string;
      };

      await db.query(
        `UPDATE support_request_pages
         SET return_refund_gate_status = 'return-condition-disputed',
             return_condition_disputed_at = $2
         WHERE support_request_id = $1`,
        [data.supportRequestId, data.disputedAt],
      );
    },
    "support.support-request.return-refund-released": async (event) => {
      const data = event.data as {
        supportRequestId: string;
      };

      await db.query(
        `UPDATE support_request_pages
         SET return_refund_gate_status = 'return-refund-released'
         WHERE support_request_id = $1`,
        [data.supportRequestId],
      );
    },
  };
}
