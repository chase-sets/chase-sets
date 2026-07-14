import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  ReturnShipmentCarrierAcceptedEvent,
  ReturnShipmentCancelledEvent,
  ReturnShipmentDeliveredEvent,
  ReturnShipmentExceptionRaisedEvent,
  ReturnShipmentExpiredEvent,
  ReturnShipmentInTransitRecordedEvent,
  ReturnShipmentLabelReadyEvent,
  ReturnShipmentReceivedEvent,
  ReturnShipmentRequestedEvent,
} from "../domain/domain";

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

  return {
    "fulfillment.return-shipment.requested.v1": async (event) => {
      const data = event.data as ReturnShipmentRequestedEvent["data"];
      const destination = data.destinationSnapshot;
      await db.query(
        `INSERT INTO fulfillment_return_shipment_operator_pages (
           return_shipment_id, remedy_id, support_request_id, order_id, outbound_shipment_id,
           return_directive, status, ship_from_snapshot, destination_snapshot, facility_id,
           facility_config_version, selection_policy_version, package_requirements, label_status,
           cost_payer, cost_allocation_reference, ship_by_deadline_at, return_by_deadline_at,
           policy_version, idempotency_key, milestones, exceptions, requested_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7::jsonb, $8::jsonb, $9, $10, $11, $12::jsonb,
           'pending', $13, $14, $15::timestamptz, $16::timestamptz, $17, $18, $19::jsonb, '[]'::jsonb,
           $20::timestamptz, $20::timestamptz)
         ON CONFLICT (return_shipment_id) DO UPDATE SET
           remedy_id = EXCLUDED.remedy_id,
           support_request_id = EXCLUDED.support_request_id,
           order_id = EXCLUDED.order_id,
           outbound_shipment_id = EXCLUDED.outbound_shipment_id,
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
    },
    "fulfillment.return-shipment.label-ready.v1": async (event) => {
      const data = event.data as ReturnShipmentLabelReadyEvent["data"];
      await db.query(
        `UPDATE fulfillment_return_shipment_operator_pages
         SET status = 'ready-to-ship', label_status = 'ready', carrier_name = $2, tracking_identifier = $3,
             label_provider_reference = $4, label_ready_at = $5, updated_at = $5,
             milestones = milestones || $6::jsonb
         WHERE return_shipment_id = $1`,
        [
          data.returnShipmentId,
          data.carrierName,
          data.trackingIdentifier,
          data.labelProviderReference,
          data.readyAt,
          milestoneJson("ready-to-ship", data.readyAt, null),
        ],
      );
      await db.query(
        `UPDATE fulfillment_return_shipment_customer_pages
         SET status = 'ready-to-ship', carrier_name = $2, tracking_identifier = $3, updated_at = $4
         WHERE return_shipment_id = $1`,
        [data.returnShipmentId, data.carrierName, data.trackingIdentifier, data.readyAt],
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
    "fulfillment.return-shipment.received.v1": async (event) => {
      const data = event.data as ReturnShipmentReceivedEvent["data"];
      await db.query(
        `UPDATE fulfillment_return_shipment_operator_pages
         SET status = 'received', received_at = $2, updated_at = $2,
             current_exception_type = NULL, current_exception_notes = NULL,
             milestones = milestones || $3::jsonb
         WHERE return_shipment_id = $1`,
        [data.returnShipmentId, data.receivedAt, milestoneJson("received", data.receivedAt, data.detail)],
      );
      await db.query(
        `UPDATE fulfillment_return_shipment_customer_pages
         SET status = 'received', received_at = $2, updated_at = $2, current_exception_type = NULL
         WHERE return_shipment_id = $1`,
        [data.returnShipmentId, data.receivedAt],
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
  };
}
