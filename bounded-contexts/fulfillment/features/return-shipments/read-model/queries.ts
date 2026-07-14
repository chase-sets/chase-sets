import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Read-model queries for the ReturnShipment aggregate.
 *
 * Customer queries read only `fulfillment_return_shipment_customer_pages`, which
 * has no facility postal address, facility id/version, ship-from party address,
 * operational routing, or cost allocation — so protected metadata cannot be
 * returned to a buyer. Operator queries read the operator page, which carries the
 * destination snapshot, party snapshot, custody timeline, deadlines, and cost
 * payer needed to resolve exceptions without joining another context's database.
 */

export type CustomerReturnShipmentView = Readonly<{
  return_shipment_id: string;
  remedy_id: string;
  status: string;
  carrier_name: string | null;
  tracking_identifier: string | null;
  destination_display_name: string;
  destination_display_instructions: string;
  destination_region: string;
  destination_city: string;
  destination_state: string;
  ship_by_deadline_at: string;
  return_by_deadline_at: string;
  current_exception_type: string | null;
  requested_at: string;
  delivered_at: string | null;
  received_at: string | null;
  cancelled_at: string | null;
  return_expired_at: string | null;
  updated_at: string;
}>;

const customerColumns = `return_shipment_id, remedy_id, status, carrier_name, tracking_identifier,
  destination_display_name, destination_display_instructions, destination_region, destination_city,
  destination_state, ship_by_deadline_at, return_by_deadline_at, current_exception_type, requested_at,
  delivered_at, received_at, cancelled_at, return_expired_at, updated_at`;

export async function getCustomerReturnShipment(
  db: PgQueryable,
  returnShipmentId: string,
): Promise<CustomerReturnShipmentView | null> {
  const result = await db.query<CustomerReturnShipmentView>(
    `SELECT ${customerColumns}
     FROM fulfillment_return_shipment_customer_pages
     WHERE return_shipment_id = $1`,
    [returnShipmentId],
  );
  return result.rows[0] ?? null;
}

export async function listCustomerReturnShipmentsForRemedy(
  db: PgQueryable,
  remedyId: string,
): Promise<readonly CustomerReturnShipmentView[]> {
  const result = await db.query<CustomerReturnShipmentView>(
    `SELECT ${customerColumns}
     FROM fulfillment_return_shipment_customer_pages
     WHERE remedy_id = $1
     ORDER BY requested_at ASC, return_shipment_id ASC`,
    [remedyId],
  );
  return result.rows;
}

export type OperatorReturnShipmentView = Readonly<{
  return_shipment_id: string;
  remedy_id: string;
  support_request_id: string;
  order_id: string;
  outbound_shipment_id: string;
  return_directive: string;
  status: string;
  ship_from_snapshot: unknown;
  destination_snapshot: unknown;
  facility_id: string;
  facility_config_version: string;
  selection_policy_version: string;
  package_requirements: unknown;
  label_status: string;
  label_provider_reference: string | null;
  carrier_name: string | null;
  tracking_identifier: string | null;
  cost_payer: string;
  cost_allocation_reference: string | null;
  ship_by_deadline_at: string;
  return_by_deadline_at: string;
  policy_version: string;
  idempotency_key: string;
  current_exception_type: string | null;
  current_exception_notes: string | null;
  milestones: unknown;
  exceptions: unknown;
  requested_at: string;
  label_ready_at: string | null;
  carrier_accepted_at: string | null;
  delivered_at: string | null;
  received_at: string | null;
  cancelled_at: string | null;
  return_expired_at: string | null;
  updated_at: string;
}>;

const operatorColumns = `return_shipment_id, remedy_id, support_request_id, order_id, outbound_shipment_id,
  return_directive, status, ship_from_snapshot, destination_snapshot, facility_id, facility_config_version,
  selection_policy_version, package_requirements, label_status, label_provider_reference, carrier_name,
  tracking_identifier, cost_payer, cost_allocation_reference, ship_by_deadline_at, return_by_deadline_at,
  policy_version, idempotency_key, current_exception_type, current_exception_notes, milestones, exceptions,
  requested_at, label_ready_at, carrier_accepted_at, delivered_at, received_at, cancelled_at,
  return_expired_at, updated_at`;

export async function getOperatorReturnShipment(
  db: PgQueryable,
  returnShipmentId: string,
): Promise<OperatorReturnShipmentView | null> {
  const result = await db.query<OperatorReturnShipmentView>(
    `SELECT ${operatorColumns}
     FROM fulfillment_return_shipment_operator_pages
     WHERE return_shipment_id = $1`,
    [returnShipmentId],
  );
  return result.rows[0] ?? null;
}

/**
 * Looks up an existing reverse shipment for a remedy. The creation flow uses this
 * to keep "one return shipment per remedy" without presuming a second aggregate
 * exists, complementing the aggregate's own idempotent-by-remedy guard.
 */
export async function findReturnShipmentIdForRemedy(db: PgQueryable, remedyId: string): Promise<string | null> {
  const result = await db.query<{ return_shipment_id: string }>(
    `SELECT return_shipment_id
     FROM fulfillment_return_shipment_operator_pages
     WHERE remedy_id = $1
     ORDER BY requested_at ASC, return_shipment_id ASC
     LIMIT 1`,
    [remedyId],
  );
  return result.rows[0]?.return_shipment_id ?? null;
}
