import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Idempotency ledger for return-label provider operations.
 *
 * A ReturnShipment stream is idempotent per remedy, but purchasing a carrier label
 * calls an external provider that charges real money — so a retried or restarted
 * request must never buy a second label. This ledger fences each purchase/void
 * behind a stable `operation_key`: the first caller reserves the row, and every
 * later caller reads the existing reservation instead of re-invoking the provider.
 * A `provider-succeeded` row records that the provider charged but the aggregate has
 * not yet observed the label, which the recovery sweep reconciles (the provider's
 * own idempotency key guarantees the recovered label is the same one).
 *
 * The table is written transactionally by the label-purchase workflow, not projected
 * from the event stream, so it is not a projection group.
 */

export type ReturnShipmentLabelOperationKind = "purchase-label" | "void-label";

export type ReturnShipmentLabelOperationStatus = "pending" | "provider-succeeded" | "succeeded" | "failed";

export type ReturnShipmentLabelOperationRecord = Readonly<{
  operation_key: string;
  operation_kind: ReturnShipmentLabelOperationKind;
  return_shipment_id: string;
  remedy_id: string;
  provider_name: string;
  provider_mode: string;
  idempotency_key: string;
  request_json: unknown;
  status: ReturnShipmentLabelOperationStatus;
  provider_shipment_id: string | null;
  provider_label_id: string | null;
  tracking_identifier: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}>;

export type ReturnShipmentLabelOperationReservation = ReturnShipmentLabelOperationRecord &
  Readonly<{ operation_reserved: boolean }>;

export function returnShipmentLabelOperationHasProviderLabel(operation: ReturnShipmentLabelOperationRecord): boolean {
  return Boolean(operation.provider_shipment_id && operation.provider_label_id && operation.tracking_identifier);
}

export async function recordReturnShipmentLabelOperationPending(
  db: PgQueryable,
  operation: Readonly<{
    operationKey: string;
    operationKind: ReturnShipmentLabelOperationKind;
    returnShipmentId: string;
    remedyId: string;
    providerName: string;
    providerMode: string;
    idempotencyKey: string;
    request?: unknown;
    createdAt?: string;
  }>,
): Promise<ReturnShipmentLabelOperationReservation> {
  const timestamp = operation.createdAt ?? new Date().toISOString();
  const result = await db.query<ReturnShipmentLabelOperationReservation>(
    `WITH reserved_operation AS (
       INSERT INTO fulfillment_return_shipment_label_operations (
         operation_key,
         operation_kind,
         return_shipment_id,
         remedy_id,
         provider_name,
         provider_mode,
         idempotency_key,
         request_json,
         status,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending', $9, $9)
       ON CONFLICT (operation_key) DO UPDATE
       SET provider_name = EXCLUDED.provider_name,
           provider_mode = EXCLUDED.provider_mode,
           idempotency_key = EXCLUDED.idempotency_key,
           request_json = EXCLUDED.request_json,
           status = 'pending',
           provider_shipment_id = NULL,
           provider_label_id = NULL,
           tracking_identifier = NULL,
           error_message = NULL,
           completed_at = NULL,
           updated_at = EXCLUDED.updated_at
       WHERE fulfillment_return_shipment_label_operations.status = 'failed'
       RETURNING
         operation_key,
         operation_kind,
         return_shipment_id,
         remedy_id,
         provider_name,
         provider_mode,
         idempotency_key,
         request_json,
         status,
         provider_shipment_id,
         provider_label_id,
         tracking_identifier,
         error_message,
         created_at,
         updated_at,
         completed_at,
         TRUE AS operation_reserved
     )
     SELECT * FROM reserved_operation
     UNION ALL
     SELECT
       existing.operation_key,
       existing.operation_kind,
       existing.return_shipment_id,
       existing.remedy_id,
       existing.provider_name,
       existing.provider_mode,
       existing.idempotency_key,
       existing.request_json,
       existing.status,
       existing.provider_shipment_id,
       existing.provider_label_id,
       existing.tracking_identifier,
       existing.error_message,
       existing.created_at,
       existing.updated_at,
       existing.completed_at,
       FALSE AS operation_reserved
     FROM fulfillment_return_shipment_label_operations AS existing
     WHERE existing.operation_key = $1
       AND NOT EXISTS (SELECT 1 FROM reserved_operation)`,
    [
      operation.operationKey,
      operation.operationKind,
      operation.returnShipmentId,
      operation.remedyId,
      operation.providerName,
      operation.providerMode,
      operation.idempotencyKey,
      JSON.stringify(operation.request ?? {}),
      timestamp,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    return {
      operation_key: operation.operationKey,
      operation_kind: operation.operationKind,
      return_shipment_id: operation.returnShipmentId,
      remedy_id: operation.remedyId,
      provider_name: operation.providerName,
      provider_mode: operation.providerMode,
      idempotency_key: operation.idempotencyKey,
      request_json: operation.request ?? {},
      status: "pending",
      provider_shipment_id: null,
      provider_label_id: null,
      tracking_identifier: null,
      error_message: null,
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: null,
      operation_reserved: true,
    };
  }
  return row;
}

export async function recordReturnShipmentLabelOperationProviderSucceeded(
  db: PgQueryable,
  operation: Readonly<{
    operationKey: string;
    providerShipmentId?: string | null;
    providerLabelId?: string | null;
    trackingIdentifier?: string | null;
    updatedAt?: string;
  }>,
): Promise<void> {
  const timestamp = operation.updatedAt ?? new Date().toISOString();
  await db.query(
    `UPDATE fulfillment_return_shipment_label_operations
     SET status = 'provider-succeeded',
         provider_shipment_id = $2,
         provider_label_id = $3,
         tracking_identifier = $4,
         error_message = NULL,
         updated_at = $5
     WHERE operation_key = $1
       AND status IN ('pending', 'provider-succeeded', 'failed')`,
    [
      operation.operationKey,
      operation.providerShipmentId ?? null,
      operation.providerLabelId ?? null,
      operation.trackingIdentifier ?? null,
      timestamp,
    ],
  );
}

export async function recordReturnShipmentLabelOperationSucceeded(
  db: PgQueryable,
  operation: Readonly<{
    operationKey: string;
    providerShipmentId?: string | null;
    providerLabelId?: string | null;
    trackingIdentifier?: string | null;
    completedAt?: string;
  }>,
): Promise<void> {
  const timestamp = operation.completedAt ?? new Date().toISOString();
  await db.query(
    `UPDATE fulfillment_return_shipment_label_operations
     SET status = 'succeeded',
         provider_shipment_id = $2,
         provider_label_id = $3,
         tracking_identifier = $4,
         error_message = NULL,
         completed_at = $5,
         updated_at = $5
     WHERE operation_key = $1
       AND status IN ('pending', 'provider-succeeded', 'succeeded', 'failed')`,
    [
      operation.operationKey,
      operation.providerShipmentId ?? null,
      operation.providerLabelId ?? null,
      operation.trackingIdentifier ?? null,
      timestamp,
    ],
  );
}

export async function recordReturnShipmentLabelOperationFailed(
  db: PgQueryable,
  operation: Readonly<{ operationKey: string; errorMessage: string; completedAt?: string }>,
): Promise<void> {
  const timestamp = operation.completedAt ?? new Date().toISOString();
  await db.query(
    `UPDATE fulfillment_return_shipment_label_operations
     SET status = 'failed',
         error_message = $2,
         completed_at = $3,
         updated_at = $3
     WHERE operation_key = $1
       AND status IN ('pending', 'provider-succeeded', 'failed')`,
    [operation.operationKey, operation.errorMessage, timestamp],
  );
}

export async function listStaleReturnShipmentLabelOperations(
  db: PgQueryable,
  params: Readonly<{ staleBefore: string; limit?: number; operationKind?: ReturnShipmentLabelOperationKind }>,
): Promise<readonly ReturnShipmentLabelOperationRecord[]> {
  const result = await db.query<ReturnShipmentLabelOperationRecord>(
    `SELECT operation_key, operation_kind, return_shipment_id, remedy_id, provider_name, provider_mode,
            idempotency_key, request_json, status, provider_shipment_id, provider_label_id,
            tracking_identifier, error_message, created_at, updated_at, completed_at
     FROM fulfillment_return_shipment_label_operations
     WHERE status IN ('pending', 'provider-succeeded')
       AND updated_at <= $1
       AND ($3::text IS NULL OR operation_kind = $3)
     ORDER BY updated_at ASC, operation_key ASC
     LIMIT $2`,
    [params.staleBefore, params.limit ?? 50, params.operationKind ?? null],
  );
  return result.rows;
}
