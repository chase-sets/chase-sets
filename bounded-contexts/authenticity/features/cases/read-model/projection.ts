import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildAuthenticityCaseProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "authenticity.case.opened": async (event) => {
      const data = event.data as {
        caseId: string;
        orderId: string;
        sellerAccountId: string;
        buyerAccountId: string;
        orderSnapshot: unknown;
        authenticityPlan: unknown;
        openedAt: string;
      };

      await db.query(
        `INSERT INTO authenticity_cases (
           case_id,
           order_id,
           seller_account_id,
           buyer_account_id,
           order_snapshot,
           authenticity_plan,
           status,
           opened_at,
           created_at,
           updated_at,
           last_stream_version
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'awaiting-inbound', $7, $8, $8, $9)
         ON CONFLICT (case_id) DO UPDATE
         SET order_id = $2,
             seller_account_id = $3,
             buyer_account_id = $4,
             order_snapshot = $5,
             authenticity_plan = $6,
             status = 'awaiting-inbound',
             opened_at = $7,
             updated_at = $8,
             last_stream_version = $9
         WHERE authenticity_cases.last_stream_version < $9`,
        [
          data.caseId,
          data.orderId,
          data.sellerAccountId,
          data.buyerAccountId,
          JSON.stringify(data.orderSnapshot),
          JSON.stringify(data.authenticityPlan),
          data.openedAt,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "authenticity.case.inbound-tracking-recorded": async (event) => {
      const data = event.data as { caseId: string; inboundTrackingIdentifier: string };

      await db.query(
        `UPDATE authenticity_cases
         SET inbound_tracking_identifier = $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE case_id = $1
           AND last_stream_version < $4`,
        [data.caseId, data.inboundTrackingIdentifier, event.timing.recordedAt, event.streamVersion],
      );
    },
    "authenticity.case.received": async (event) => {
      const data = event.data as { caseId: string; receivedAt: string };

      await db.query(
        `UPDATE authenticity_cases
         SET status = 'received',
             received_at = $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE case_id = $1
           AND last_stream_version < $4`,
        [data.caseId, data.receivedAt, event.timing.recordedAt, event.streamVersion],
      );
    },
    "authenticity.case.inspection-started": async (event) => {
      const data = event.data as { caseId: string; inspectorAccountId: string; startedAt: string };

      await db.query(
        `UPDATE authenticity_cases
         SET status = 'inspecting',
             inspector_account_id = $2,
             inspection_started_at = $3,
             updated_at = $4,
             last_stream_version = $5
         WHERE case_id = $1
           AND last_stream_version < $5`,
        [data.caseId, data.inspectorAccountId, data.startedAt, event.timing.recordedAt, event.streamVersion],
      );
    },
    "authenticity.case.verdict-recorded": async (event) => {
      const data = event.data as {
        caseId: string;
        verdict: string;
        reasonCodes: readonly string[];
        checklistResults: unknown;
        evidencePhotoRefs: readonly string[];
        lineNotes: unknown;
        inspectorAccountId: string;
        decidedAt: string;
      };

      await db.query(
        `UPDATE authenticity_cases
         SET status = $2,
             verdict = $2,
             verdict_reason_codes = $3,
             checklist_results = $4,
             evidence_photo_refs = $5,
             line_notes = $6,
             inspector_account_id = $7,
             verdict_recorded_at = $8,
             updated_at = $9,
             last_stream_version = $10
         WHERE case_id = $1
           AND last_stream_version < $10`,
        [
          data.caseId,
          data.verdict,
          JSON.stringify(data.reasonCodes),
          JSON.stringify(data.checklistResults),
          JSON.stringify(data.evidencePhotoRefs),
          JSON.stringify(data.lineNotes),
          data.inspectorAccountId,
          data.decidedAt,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "authenticity.case.forwarded": async (event) => {
      const data = event.data as { caseId: string; forwardedAt: string; outboundTrackingIdentifier: string | null };

      await db.query(
        `UPDATE authenticity_cases
         SET status = 'forwarded',
             forwarded_at = $2,
             outbound_tracking_identifier = $3,
             updated_at = $4,
             last_stream_version = $5
         WHERE case_id = $1
           AND last_stream_version < $5`,
        [data.caseId, data.forwardedAt, data.outboundTrackingIdentifier, event.timing.recordedAt, event.streamVersion],
      );
    },
    "authenticity.case.returned": async (event) => {
      const data = event.data as { caseId: string; returnedAt: string; returnReason: string | null };

      await db.query(
        `UPDATE authenticity_cases
         SET status = 'returned',
             returned_at = $2,
             return_reason = $3,
             updated_at = $4,
             last_stream_version = $5
         WHERE case_id = $1
           AND last_stream_version < $5`,
        [data.caseId, data.returnedAt, data.returnReason, event.timing.recordedAt, event.streamVersion],
      );
    },
  };
}
