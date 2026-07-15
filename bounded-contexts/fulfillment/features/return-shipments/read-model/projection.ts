import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  ReturnShipmentCarrierAcceptedEvent,
  ReturnShipmentCancelledEvent,
  ReturnShipmentDeliveredEvent,
  ReturnShipmentExceptionRaisedEvent,
  ReturnShipmentExpiredEvent,
  ReturnShipmentInTransitRecordedEvent,
  ReturnShipmentLabelPurchaseFailedEvent,
  ReturnShipmentLabelReadyEvent,
  ReturnShipmentLabelVoidedEvent,
  ReturnShipmentDuplicateIntakeScanObservedEvent,
  ReturnShipmentFacilityIntakeCompletedEvent,
  ReturnShipmentFacilityIntakeCorrectedEvent,
  ReturnShipmentRequestedEvent,
} from "../domain/domain";
import type {
  UnidentifiedReturnPackageReconciledEvent,
  UnidentifiedReturnPackageRecordedEvent,
} from "../domain/unidentified-package";

type Milestone = Readonly<{ status: string; occurredAt: string; detail: string | null }>;

function milestoneJson(status: string, occurredAt: string, detail: string | null): string {
  return JSON.stringify([{ status, occurredAt, detail } satisfies Milestone]);
}

/**
 * Projects the ReturnShipment stream into two separate read models. The
 * `requested.v1` handler seeds both rows with an idempotent upsert (so a
 * projection rebuild replays cleanly); later milestone handlers advance status,
 * stamp the matching timestamp, and append to the operator custody timeline. The
 * customer projection never receives the ship-from address, facility postal
 * address, facility id/version, operational routing, or cost allocation.
 */
export function buildFulfillmentReturnShipmentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  async function advanceStatus(
    returnShipmentId: string,
    status: string,
    updatedAt: string,
    milestoneDetail: string | null,
    operatorTimestampColumn: string | null,
    customerTimestampColumn: string | null,
  ): Promise<void> {
    const operatorSets = [
      "status = $2",
      "updated_at = $3",
      "milestones = milestones || $4::jsonb",
      ...(operatorTimestampColumn ? [`${operatorTimestampColumn} = $3`] : []),
    ];
    await db.query(
      `UPDATE fulfillment_return_shipment_operator_pages
       SET ${operatorSets.join(", ")}
       WHERE return_shipment_id = $1`,
      [returnShipmentId, status, updatedAt, milestoneJson(status, updatedAt, milestoneDetail)],
    );
    const customerSets = [
      "status = $2",
      "updated_at = $3",
      ...(customerTimestampColumn ? [`${customerTimestampColumn} = $3`] : []),
    ];
    await db.query(
      `UPDATE fulfillment_return_shipment_customer_pages
       SET ${customerSets.join(", ")}
       WHERE return_shipment_id = $1`,
      [returnShipmentId, status, updatedAt],
    );
  }

  const projectRequested = async (event: Parameters<ProjectorHandlerMap[string]>[0]) => {
    const data = event.data as ReturnShipmentRequestedEvent["data"];
    const affectedOrderLineIds = "affectedOrderLineIds" in data ? data.affectedOrderLineIds : [];
    const destination = data.destinationSnapshot;
    await db.query(
      `INSERT INTO fulfillment_return_shipment_operator_pages (
           return_shipment_id, remedy_id, support_request_id, order_id, outbound_shipment_id,
           return_directive, status, ship_from_snapshot, destination_snapshot, facility_id,
           facility_config_version, selection_policy_version, package_requirements, label_status,
           cost_payer, cost_allocation_reference, ship_by_deadline_at, return_by_deadline_at,
           policy_version, idempotency_key, milestones, exceptions, affected_order_line_ids, requested_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7::jsonb, $8::jsonb, $9, $10, $11, $12::jsonb,
           'pending', $13, $14, $15::timestamptz, $16::timestamptz, $17, $18, $19::jsonb, '[]'::jsonb,
           $21::jsonb, $20::timestamptz, $20::timestamptz)
         ON CONFLICT (return_shipment_id) DO UPDATE SET
           remedy_id = EXCLUDED.remedy_id,
           support_request_id = EXCLUDED.support_request_id,
           order_id = EXCLUDED.order_id,
           outbound_shipment_id = EXCLUDED.outbound_shipment_id,
           affected_order_line_ids = EXCLUDED.affected_order_line_ids,
           return_directive = EXCLUDED.return_directive,
           ship_from_snapshot = EXCLUDED.ship_from_snapshot,
           destination_snapshot = EXCLUDED.destination_snapshot,
           facility_id = EXCLUDED.facility_id,
           facility_config_version = EXCLUDED.facility_config_version,
           selection_policy_version = EXCLUDED.selection_policy_version,
           package_requirements = EXCLUDED.package_requirements,
           cost_payer = EXCLUDED.cost_payer,
           cost_allocation_reference = EXCLUDED.cost_allocation_reference,
           ship_by_deadline_at = EXCLUDED.ship_by_deadline_at,
           return_by_deadline_at = EXCLUDED.return_by_deadline_at,
           policy_version = EXCLUDED.policy_version,
           idempotency_key = EXCLUDED.idempotency_key`,
      [
        data.returnShipmentId,
        data.remedyId,
        data.supportRequestId,
        data.orderId,
        data.outboundShipmentId,
        data.returnDirective,
        JSON.stringify(data.shipFromSnapshot),
        JSON.stringify(destination),
        destination.facilityId,
        destination.configVersion,
        destination.selectionPolicyVersion,
        JSON.stringify(data.packageRequirements),
        data.costPayer,
        data.costAllocationReference,
        data.shipByDeadlineAt,
        data.returnByDeadlineAt,
        data.metadata.policyVersion,
        data.metadata.idempotencyKey,
        milestoneJson("requested", data.requestedAt, null),
        data.requestedAt,
        JSON.stringify(affectedOrderLineIds),
      ],
    );
    await db.query(
      `INSERT INTO fulfillment_return_shipment_customer_pages (
           return_shipment_id, remedy_id, status, destination_display_name,
           destination_display_instructions, destination_region, destination_city, destination_state,
           ship_by_deadline_at, return_by_deadline_at, requested_at, updated_at
         )
         VALUES ($1, $2, 'requested', $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $10::timestamptz)
         ON CONFLICT (return_shipment_id) DO UPDATE SET
           remedy_id = EXCLUDED.remedy_id,
           destination_display_name = EXCLUDED.destination_display_name,
           destination_display_instructions = EXCLUDED.destination_display_instructions,
           destination_region = EXCLUDED.destination_region,
           destination_city = EXCLUDED.destination_city,
           destination_state = EXCLUDED.destination_state,
           ship_by_deadline_at = EXCLUDED.ship_by_deadline_at,
           return_by_deadline_at = EXCLUDED.return_by_deadline_at`,
      [
        data.returnShipmentId,
        data.remedyId,
        destination.displayName,
        destination.displayInstructions,
        destination.region,
        destination.postalAddress.city,
        destination.postalAddress.state,
        data.shipByDeadlineAt,
        data.returnByDeadlineAt,
        data.requestedAt,
      ],
    );
  };

  return {
    "fulfillment.return-shipment.requested.v1": projectRequested,
    "fulfillment.return-shipment.requested.v2": projectRequested,
    "fulfillment.return-shipment.label-ready.v1": async (event) => {
      const data = event.data as ReturnShipmentLabelReadyEvent["data"];
      await db.query(
        `UPDATE fulfillment_return_shipment_operator_pages
         SET status = 'ready-to-ship', label_status = 'ready', carrier_name = $2, tracking_identifier = $3,
             label_provider_reference = $4, label_document_url = $5, postage_provider_name = $6,
             postage_provider_mode = $7, postage_provider_shipment_id = $8, postage_provider_label_id = $9,
             postage_amount_cents = $10, estimated_postage_amount_cents = $11, postage_currency = $12,
             label_failure_reason = NULL, label_failure_detail = NULL, label_ready_at = $13, updated_at = $13,
             milestones = milestones || $14::jsonb
         WHERE return_shipment_id = $1`,
        [
          data.returnShipmentId,
          data.carrierName,
          data.trackingIdentifier,
          data.labelProviderReference,
          data.labelDocumentUrl,
          data.postageProviderName,
          data.postageProviderMode,
          data.postageProviderShipmentId,
          data.postageProviderLabelId,
          data.postageAmountCents,
          data.estimatedPostageAmountCents,
          data.postageCurrency,
          data.readyAt,
          milestoneJson("ready-to-ship", data.readyAt, null),
        ],
      );
      await db.query(
        `UPDATE fulfillment_return_shipment_customer_pages
         SET status = 'ready-to-ship', label_status = 'ready', carrier_name = $2, tracking_identifier = $3,
             label_document_url = $4, label_failure_reason = NULL, updated_at = $5
         WHERE return_shipment_id = $1`,
        [data.returnShipmentId, data.carrierName, data.trackingIdentifier, data.labelDocumentUrl, data.readyAt],
      );
    },
    "fulfillment.return-shipment.label-purchase-failed.v1": async (event) => {
      const data = event.data as ReturnShipmentLabelPurchaseFailedEvent["data"];
      await db.query(
        `UPDATE fulfillment_return_shipment_operator_pages
         SET label_status = 'failed', label_failure_reason = $2, label_failure_detail = $3,
             label_failed_at = $4, updated_at = $4
         WHERE return_shipment_id = $1`,
        [data.returnShipmentId, data.failureReason, data.failureDetail, data.failedAt],
      );
      await db.query(
        `UPDATE fulfillment_return_shipment_customer_pages
         SET label_status = 'failed', label_failure_reason = $2, updated_at = $3
         WHERE return_shipment_id = $1`,
        [data.returnShipmentId, data.failureReason, data.failedAt],
      );
    },
    "fulfillment.return-shipment.label-voided.v1": async (event) => {
      const data = event.data as ReturnShipmentLabelVoidedEvent["data"];
      await db.query(
        `UPDATE fulfillment_return_shipment_operator_pages
         SET label_status = 'voided', label_refund_status = $2, label_refund_reference = $3,
             label_voided_at = $4, updated_at = $4
         WHERE return_shipment_id = $1`,
        [data.returnShipmentId, data.refundStatus, data.refundReference, data.voidedAt],
      );
      await db.query(
        `UPDATE fulfillment_return_shipment_customer_pages
         SET label_status = 'voided', label_document_url = NULL, updated_at = $2
         WHERE return_shipment_id = $1`,
        [data.returnShipmentId, data.voidedAt],
      );
    },
    "fulfillment.return-shipment.carrier-accepted.v1": async (event) => {
      const data = event.data as ReturnShipmentCarrierAcceptedEvent["data"];
      await advanceStatus(
        data.returnShipmentId,
        "carrier-accepted",
        data.occurredAt,
        data.detail,
        "carrier_accepted_at",
        null,
      );
    },
    "fulfillment.return-shipment.in-transit-recorded.v1": async (event) => {
      const data = event.data as ReturnShipmentInTransitRecordedEvent["data"];
      await advanceStatus(data.returnShipmentId, "in-transit", data.occurredAt, data.detail, null, null);
    },
    "fulfillment.return-shipment.delivered.v1": async (event) => {
      const data = event.data as ReturnShipmentDeliveredEvent["data"];
      await advanceStatus(
        data.returnShipmentId,
        "delivered",
        data.deliveredAt,
        data.detail,
        "delivered_at",
        "delivered_at",
      );
    },
    "fulfillment.return-shipment.facility-intake-completed.v1": async (event) => {
      const data = event.data as ReturnShipmentFacilityIntakeCompletedEvent["data"];
      await db.query(
        `UPDATE fulfillment_return_shipment_operator_pages
         SET status = 'received', received_at = $2, updated_at = $2,
             current_exception_type = NULL, current_exception_notes = NULL,
             facility_intake = $3::jsonb,
             milestones = milestones || $4::jsonb
         WHERE return_shipment_id = $1`,
        [
          data.returnShipmentId,
          data.intake.receivedAt,
          JSON.stringify(data.intake),
          milestoneJson("received", data.intake.receivedAt, data.intake.disposition),
        ],
      );
      await db.query(
        `UPDATE fulfillment_return_shipment_customer_pages
         SET status = 'received', received_at = $2, updated_at = $2, current_exception_type = NULL
         WHERE return_shipment_id = $1`,
        [data.returnShipmentId, data.intake.receivedAt],
      );
    },
    "fulfillment.return-shipment.facility-intake-corrected.v1": async (event) => {
      const data = event.data as ReturnShipmentFacilityIntakeCorrectedEvent["data"];
      await db.query(
        `UPDATE fulfillment_return_shipment_operator_pages
         SET intake_corrections = intake_corrections || $2::jsonb,
             facility_intake = jsonb_set(
               jsonb_set(
                 jsonb_set(facility_intake, '{custodyIdentifier}',
                   COALESCE(to_jsonb($3::text), facility_intake->'custodyIdentifier')),
                 '{discrepancies}',
                 COALESCE((
                   SELECT jsonb_agg(
                     jsonb_set(jsonb_set(entry, '{owner}', COALESCE(to_jsonb($4::text), entry->'owner')),
                       '{nextAction}', COALESCE(to_jsonb($5::text), entry->'nextAction'))
                   ) FROM jsonb_array_elements(facility_intake->'discrepancies') entry
                 ), '[]'::jsonb)),
               '{lastCorrectedAt}', to_jsonb($6::text)),
             updated_at = $6::timestamptz
         WHERE return_shipment_id = $1`,
        [
          data.returnShipmentId,
          JSON.stringify([data.correction]),
          data.correction.custodyIdentifier,
          data.correction.owner,
          data.correction.nextAction,
          data.correction.correctedAt,
        ],
      );
    },
    "fulfillment.return-shipment.duplicate-intake-scan-observed.v1": async (event) => {
      const data = event.data as ReturnShipmentDuplicateIntakeScanObservedEvent["data"];
      await db.query(
        `UPDATE fulfillment_return_shipment_operator_pages
         SET duplicate_intake_scan_count = duplicate_intake_scan_count + 1,
             updated_at = GREATEST(updated_at, $2::timestamptz)
         WHERE return_shipment_id = $1`,
        [data.returnShipmentId, data.observedAt],
      );
    },
    "fulfillment.return-shipment.cancelled.v1": async (event) => {
      const data = event.data as ReturnShipmentCancelledEvent["data"];
      await advanceStatus(
        data.returnShipmentId,
        "cancelled",
        data.cancelledAt,
        data.reason,
        "cancelled_at",
        "cancelled_at",
      );
    },
    "fulfillment.return-shipment.expired.v1": async (event) => {
      const data = event.data as ReturnShipmentExpiredEvent["data"];
      await advanceStatus(
        data.returnShipmentId,
        "expired",
        data.expiredAt,
        data.reason,
        "return_expired_at",
        "return_expired_at",
      );
    },
    "fulfillment.return-shipment.exception-raised.v1": async (event) => {
      const data = event.data as ReturnShipmentExceptionRaisedEvent["data"];
      await db.query(
        `UPDATE fulfillment_return_shipment_operator_pages
         SET current_exception_type = $2, current_exception_notes = $3, updated_at = $4,
             exceptions = exceptions || $5::jsonb
         WHERE return_shipment_id = $1`,
        [
          data.returnShipmentId,
          data.exceptionType,
          data.notes,
          data.raisedAt,
          JSON.stringify([{ exceptionType: data.exceptionType, notes: data.notes, raisedAt: data.raisedAt }]),
        ],
      );
      await db.query(
        `UPDATE fulfillment_return_shipment_customer_pages
         SET current_exception_type = $2, updated_at = $3
         WHERE return_shipment_id = $1`,
        [data.returnShipmentId, data.exceptionType, data.raisedAt],
      );
    },
    "fulfillment.unidentified-return-package.recorded.v1": async (event) => {
      const data = event.data as UnidentifiedReturnPackageRecordedEvent["data"];
      await db.query(
        `INSERT INTO fulfillment_unidentified_return_package_pages (
           unidentified_package_id, facility_id, station_id, operator_user_id, received_at,
           package_condition, seal_condition, measured_weight_ounces, evidence, custody_identifier,
           notes, owner, next_action, updated_at
         ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $5::timestamptz)
         ON CONFLICT (unidentified_package_id) DO UPDATE SET
           facility_id = EXCLUDED.facility_id,
           station_id = EXCLUDED.station_id,
           operator_user_id = EXCLUDED.operator_user_id,
           received_at = EXCLUDED.received_at,
           package_condition = EXCLUDED.package_condition,
           seal_condition = EXCLUDED.seal_condition,
           measured_weight_ounces = EXCLUDED.measured_weight_ounces,
           evidence = EXCLUDED.evidence,
           custody_identifier = EXCLUDED.custody_identifier,
           notes = EXCLUDED.notes,
           owner = EXCLUDED.owner,
           next_action = EXCLUDED.next_action,
           updated_at = EXCLUDED.updated_at`,
        [
          data.unidentifiedPackageId,
          data.facilityId,
          data.stationId,
          data.operatorUserId,
          data.receivedAt,
          data.packageCondition,
          data.sealCondition,
          data.measuredWeightOunces,
          JSON.stringify(data.evidence),
          data.custodyIdentifier,
          data.notes,
          data.owner,
          data.nextAction,
        ],
      );
    },
    "fulfillment.unidentified-return-package.reconciled.v1": async (event) => {
      const data = event.data as UnidentifiedReturnPackageReconciledEvent["data"];
      await db.query(
        `UPDATE fulfillment_unidentified_return_package_pages
         SET return_shipment_id = $2, reconciled_by_user_id = $3, reconciled_at = $4::timestamptz,
             reconciliation_reason = $5, updated_at = $4::timestamptz
         WHERE unidentified_package_id = $1`,
        [data.unidentifiedPackageId, data.returnShipmentId, data.reconciledByUserId, data.reconciledAt, data.reason],
      );
    },
  };
}
