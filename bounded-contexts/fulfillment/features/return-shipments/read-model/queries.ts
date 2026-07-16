import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  DEFAULT_RETURN_SHIPMENT_DEADLINE_POLICY,
  deriveReturnShipmentDeadlineSignals,
  type ReturnShipmentDeadlinePolicy,
  type ReturnShipmentDeadlineSignal,
} from "./deadlines";

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
  label_status: string;
  carrier_name: string | null;
  tracking_identifier: string | null;
  label_document_url: string | null;
  label_failure_reason: string | null;
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

const customerColumns = `return_shipment_id, remedy_id, status, label_status, carrier_name, tracking_identifier,
  label_document_url, label_failure_reason, destination_display_name, destination_display_instructions,
  destination_region, destination_city, destination_state, ship_by_deadline_at, return_by_deadline_at,
  current_exception_type, requested_at, delivered_at, received_at, cancelled_at, return_expired_at, updated_at`;

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
  affected_order_line_ids: readonly string[];
  return_directive: string;
  status: string;
  ship_from_snapshot: unknown;
  destination_snapshot: unknown;
  facility_id: string | null;
  facility_config_version: string;
  selection_policy_version: string;
  package_requirements: unknown;
  label_status: string;
  label_provider_reference: string | null;
  label_document_url: string | null;
  carrier_name: string | null;
  tracking_identifier: string | null;
  postage_provider_name: string | null;
  postage_provider_mode: string | null;
  postage_provider_shipment_id: string | null;
  postage_provider_label_id: string | null;
  postage_amount_cents: number | null;
  estimated_postage_amount_cents: number | null;
  postage_currency: string | null;
  label_failure_reason: string | null;
  label_failure_detail: string | null;
  label_refund_status: string | null;
  label_refund_reference: string | null;
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
  facility_intake: unknown | null;
  intake_corrections: unknown;
  duplicate_intake_scan_count: number;
  requested_at: string;
  label_ready_at: string | null;
  label_failed_at: string | null;
  label_voided_at: string | null;
  carrier_accepted_at: string | null;
  delivered_at: string | null;
  received_at: string | null;
  cancelled_at: string | null;
  return_expired_at: string | null;
  updated_at: string;
  expected_items?: readonly ExpectedReturnItemSummary[];
}>;

export type ExpectedReturnItemSummary = Readonly<{
  line_id: string;
  order_line_id: string;
  item_title: string;
  item_subtitle: string | null;
  product_summary: string | null;
  quantity: number;
}>;

const operatorColumns = `return_shipment_id, remedy_id, support_request_id, order_id, outbound_shipment_id,
  affected_order_line_ids,
  return_directive, status, ship_from_snapshot, destination_snapshot, facility_id, facility_config_version,
  selection_policy_version, package_requirements, label_status, label_provider_reference, label_document_url,
  carrier_name, tracking_identifier, postage_provider_name, postage_provider_mode, postage_provider_shipment_id,
  postage_provider_label_id, postage_amount_cents, estimated_postage_amount_cents, postage_currency,
  label_failure_reason, label_failure_detail, label_refund_status, label_refund_reference, cost_payer,
  cost_allocation_reference, ship_by_deadline_at, return_by_deadline_at, policy_version, idempotency_key,
  current_exception_type, current_exception_notes, milestones, exceptions,
  facility_intake, intake_corrections, duplicate_intake_scan_count,
  requested_at, label_ready_at, label_failed_at, label_voided_at, carrier_accepted_at, delivered_at, received_at,
  cancelled_at,
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

export type ReturnShipmentTrackingMatch = Readonly<{
  return_shipment_id: string;
  remedy_id: string;
  status: string;
  policy_version: string;
}>;

/**
 * Resolves the reverse shipment a carrier tracking event belongs to. Matching is
 * by the immutable label tracking identifier or the postage provider's shipment
 * id, so a return label's carrier scans route back to the correct aggregate. The
 * furthest-updated row wins when a tracking identifier is reused across facilities.
 */
export async function findReturnShipmentForTracking(
  db: PgQueryable,
  match: Readonly<{ trackingIdentifier?: string | null; providerShipmentId?: string | null }>,
): Promise<ReturnShipmentTrackingMatch | null> {
  const trackingIdentifier = match.trackingIdentifier?.trim() || null;
  const providerShipmentId = match.providerShipmentId?.trim() || null;
  if (!trackingIdentifier && !providerShipmentId) {
    return null;
  }
  const result = await db.query<ReturnShipmentTrackingMatch>(
    `SELECT return_shipment_id, remedy_id, status, policy_version
     FROM fulfillment_return_shipment_operator_pages
     WHERE ($1::text IS NOT NULL AND tracking_identifier = $1)
        OR ($2::text IS NOT NULL AND postage_provider_shipment_id = $2)
     ORDER BY updated_at DESC, return_shipment_id DESC
     LIMIT 1`,
    [trackingIdentifier, providerShipmentId],
  );
  return result.rows[0] ?? null;
}

export async function listReturnShipmentDeadlineCandidates(
  db: PgQueryable,
  params: Readonly<{ now: string; limit?: number }>,
): Promise<readonly string[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  const result = await db.query<{ return_shipment_id: string }>(
    `SELECT return_shipment_id
     FROM fulfillment_return_shipment_operator_pages
     WHERE status IN ('requested', 'ready-to-ship')
       AND ship_by_deadline_at <= $1::timestamptz
     ORDER BY ship_by_deadline_at ASC, return_shipment_id ASC
     LIMIT $2`,
    [params.now, limit],
  );
  return result.rows.map((row) => row.return_shipment_id);
}

export type ReturnShipmentIntakeResolution =
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{ outcome: "ambiguous" }>
  | Readonly<{ outcome: "resolved"; shipment: OperatorReturnShipmentView }>;

export async function resolveOperatorReturnShipmentForIntake(
  db: PgQueryable,
  identifier: string,
  facilityId: string,
): Promise<ReturnShipmentIntakeResolution> {
  const normalizedIdentifier = identifier.trim();
  const result = await db.query<OperatorReturnShipmentView>(
    `SELECT ${operatorColumns},
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'line_id', line_id,
           'order_line_id', order_line_id,
           'item_title', item_title,
           'item_subtitle', item_subtitle,
           'product_summary', product_summary,
           'quantity', quantity
         ) ORDER BY line_index ASC, line_id ASC)
         FROM fulfillment_shipment_line_pages
         WHERE shipment_id = outbound_shipment_id
           AND order_line_id IN (
             SELECT jsonb_array_elements_text(affected_order_line_ids)
           )
       ), '[]'::jsonb) AS expected_items
     FROM fulfillment_return_shipment_operator_pages
     WHERE facility_id = $2
       AND (return_shipment_id = $1 OR tracking_identifier = $1)
     ORDER BY return_shipment_id ASC
     LIMIT 2`,
    [normalizedIdentifier, facilityId.trim()],
  );
  if (result.rows.length === 0) {
    return { outcome: "not-found" };
  }
  if (result.rows.length > 1) {
    return { outcome: "ambiguous" };
  }
  return { outcome: "resolved", shipment: result.rows[0] };
}

export async function listFacilityReturnIntakeQueue(
  db: PgQueryable,
  facilityId: string,
): Promise<readonly OperatorReturnShipmentView[]> {
  const result = await db.query<OperatorReturnShipmentView>(
    `SELECT ${operatorColumns}
     FROM fulfillment_return_shipment_operator_pages
     WHERE facility_id = $1
       AND status NOT IN ('cancelled', 'expired')
     ORDER BY CASE status WHEN 'delivered' THEN 0 WHEN 'received' THEN 2 ELSE 1 END,
              delivered_at ASC NULLS LAST,
              requested_at ASC,
              return_shipment_id ASC`,
    [facilityId.trim()],
  );
  return result.rows;
}

export type UnidentifiedReturnPackageView = Readonly<{
  unidentified_package_id: string;
  facility_id: string;
  station_id: string;
  operator_user_id: string;
  received_at: string;
  package_condition: string;
  seal_condition: string;
  measured_weight_ounces: number | null;
  evidence: unknown;
  custody_identifier: string;
  notes: string | null;
  owner: string;
  next_action: string;
  return_shipment_id: string | null;
  reconciled_by_user_id: string | null;
  reconciled_at: string | null;
  reconciliation_reason: string | null;
  updated_at: string;
}>;

const unidentifiedColumns = `unidentified_package_id, facility_id, station_id, operator_user_id, received_at,
  package_condition, seal_condition, measured_weight_ounces, evidence, custody_identifier, notes, owner, next_action,
  return_shipment_id, reconciled_by_user_id, reconciled_at, reconciliation_reason, updated_at`;

export async function getUnidentifiedReturnPackage(
  db: PgQueryable,
  unidentifiedPackageId: string,
): Promise<UnidentifiedReturnPackageView | null> {
  const result = await db.query<UnidentifiedReturnPackageView>(
    `SELECT ${unidentifiedColumns}
     FROM fulfillment_unidentified_return_package_pages
     WHERE unidentified_package_id = $1`,
    [unidentifiedPackageId],
  );
  return result.rows[0] ?? null;
}

export async function listUnidentifiedReturnPackages(
  db: PgQueryable,
  facilityId: string,
): Promise<readonly UnidentifiedReturnPackageView[]> {
  const result = await db.query<UnidentifiedReturnPackageView>(
    `SELECT ${unidentifiedColumns}
     FROM fulfillment_unidentified_return_package_pages
     WHERE facility_id = $1
     ORDER BY reconciled_at ASC NULLS FIRST, received_at ASC, unidentified_package_id ASC`,
    [facilityId.trim()],
  );
  return result.rows;
}

export type ReturnShipmentDeadlineReview = Readonly<{
  return_shipment_id: string;
  remedy_id: string;
  support_request_id: string;
  status: string;
  signals: readonly ReturnShipmentDeadlineSignal[];
}>;

/**
 * Lists the derived deadline/exception signals for every open reverse shipment as
 * of `asOf`. The derivation is pure and deterministic, so this query is safe to run
 * from an operator dashboard or the shared reminder job without mutating any state:
 * it reports what is due, and lets the notification/escalation machinery act.
 */
export async function listReturnShipmentDeadlineSignals(
  db: PgQueryable,
  options: Readonly<{ asOf: string; policy?: ReturnShipmentDeadlinePolicy }>,
): Promise<readonly ReturnShipmentDeadlineReview[]> {
  const policy = options.policy ?? DEFAULT_RETURN_SHIPMENT_DEADLINE_POLICY;
  const result = await db.query<{
    return_shipment_id: string;
    remedy_id: string;
    support_request_id: string;
    status: string;
    ship_by_deadline_at: string;
    label_status: string;
    delivered_at: string | null;
    received_at: string | null;
    last_movement_at: string | null;
  }>(
    `SELECT return_shipment_id, remedy_id, support_request_id, status, ship_by_deadline_at, label_status,
            delivered_at, received_at,
            (SELECT MAX((milestone->>'occurredAt')::timestamptz)
             FROM jsonb_array_elements(milestones) milestone
             WHERE milestone->>'status' IN ('carrier-accepted', 'in-transit')) AS last_movement_at
     FROM fulfillment_return_shipment_operator_pages
     WHERE status NOT IN ('received', 'cancelled', 'expired')`,
    [],
  );
  return result.rows
    .map((row) => ({
      return_shipment_id: row.return_shipment_id,
      remedy_id: row.remedy_id,
      support_request_id: row.support_request_id,
      status: row.status,
      signals: deriveReturnShipmentDeadlineSignals(
        {
          status: row.status,
          shipByDeadlineAt: row.ship_by_deadline_at,
          labelStatus: row.label_status,
          lastMovementAt: row.last_movement_at,
          deliveredAt: row.delivered_at,
          receivedAt: row.received_at,
        },
        options.asOf,
        policy,
      ),
    }))
    .filter((review) => review.signals.length > 0);
}

export type ReturnIntakeEvidenceReference = Readonly<{
  attachment_id: string;
  storage_key: string;
  content_type: string;
  retention_until: string;
}>;

export async function getReturnIntakeEvidenceReference(
  db: PgQueryable,
  attachmentId: string,
  facilityId: string,
): Promise<ReturnIntakeEvidenceReference | null> {
  const result = await db.query<ReturnIntakeEvidenceReference>(
    `SELECT evidence->>'attachmentId' AS attachment_id,
            evidence->>'storageKey' AS storage_key,
            evidence->>'contentType' AS content_type,
            evidence->>'retentionUntil' AS retention_until
     FROM (
       SELECT jsonb_array_elements(facility_intake->'evidence') AS evidence
       FROM fulfillment_return_shipment_operator_pages
       WHERE facility_id = $2 AND facility_intake IS NOT NULL
       UNION ALL
       SELECT jsonb_array_elements(evidence) AS evidence
       FROM fulfillment_unidentified_return_package_pages
       WHERE facility_id = $2
     ) attachments
     WHERE evidence->>'attachmentId' = $1
     LIMIT 1`,
    [attachmentId, facilityId.trim()],
  );
  return result.rows[0] ?? null;
}

export type ReturnIntakeMetrics = Readonly<{
  delivered_not_intaken_count: number;
  oldest_delivered_not_intaken_age_seconds: number;
  completed_intake_count: number;
  discrepancy_count: number;
  discrepancy_rate: number;
  unidentified_package_count: number;
  duplicate_scan_count: number;
  average_intake_latency_seconds: number;
}>;

export async function getReturnIntakeMetrics(db: PgQueryable, facilityId: string): Promise<ReturnIntakeMetrics> {
  const result = await db.query<ReturnIntakeMetrics>(
    `WITH shipments AS (
       SELECT status, delivered_at, received_at, facility_intake, duplicate_intake_scan_count
       FROM fulfillment_return_shipment_operator_pages
       WHERE facility_id = $1
     ), aggregate_metrics AS (
       SELECT
         COUNT(*) FILTER (WHERE delivered_at IS NOT NULL AND received_at IS NULL)::int AS delivered_not_intaken_count,
         COALESCE(MAX(EXTRACT(EPOCH FROM (now() - delivered_at))) FILTER (WHERE received_at IS NULL), 0)::float8
           AS oldest_delivered_not_intaken_age_seconds,
         COUNT(*) FILTER (WHERE received_at IS NOT NULL)::int AS completed_intake_count,
         COUNT(*) FILTER (
           WHERE facility_intake IS NOT NULL AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(facility_intake->'discrepancies') discrepancy
             WHERE discrepancy->>'type' <> 'expected'
           )
         )::int AS discrepancy_count,
         COALESCE(SUM(duplicate_intake_scan_count), 0)::int AS duplicate_scan_count,
         COALESCE(AVG(EXTRACT(EPOCH FROM (received_at - delivered_at)))
           FILTER (WHERE delivered_at IS NOT NULL AND received_at IS NOT NULL), 0)::float8
           AS average_intake_latency_seconds
       FROM shipments
     )
     SELECT aggregate_metrics.*,
       CASE WHEN completed_intake_count = 0 THEN 0
         ELSE discrepancy_count::float8 / completed_intake_count END AS discrepancy_rate,
       (SELECT COUNT(*)::int FROM fulfillment_unidentified_return_package_pages
        WHERE facility_id = $1 AND reconciled_at IS NULL) AS unidentified_package_count
     FROM aggregate_metrics`,
    [facilityId.trim()],
  );
  return (
    result.rows[0] ?? {
      delivered_not_intaken_count: 0,
      oldest_delivered_not_intaken_age_seconds: 0,
      completed_intake_count: 0,
      discrepancy_count: 0,
      discrepancy_rate: 0,
      unidentified_package_count: 0,
      duplicate_scan_count: 0,
      average_intake_latency_seconds: 0,
    }
  );
}
