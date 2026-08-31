import { createHash, randomUUID } from "node:crypto";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type PostageOperationStatus =
  | "reserved"
  | "invoking"
  | "ambiguous"
  | "provider-succeeded"
  | "effect-applied"
  | "failed-safe";

export type PostageOperationAuthority = Readonly<{
  operation_key: string;
  operation_id: string;
  operation_kind: "purchase-usps-label" | "void-label" | "orphan-label-void";
  shipment_id: string;
  tenant_id: string;
  seller_account_id: string;
  key_digest: string;
  request_hash: string;
  target_key: string;
  provider_name: string;
  provider_mode: string;
  provider_idempotency_key: string | null;
  provider_result_json: unknown | null;
  request_json: unknown;
  status: PostageOperationStatus;
  lifecycle_generation: number;
  claim_token: string | null;
  claim_expires_at: string | null;
  closed_reason: string | null;
  provider_invoked: boolean;
  provider_shipment_id: string | null;
  provider_label_id: string | null;
  tracking_identifier: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}>;

export type ClaimedPostageOperation = PostageOperationAuthority &
  Readonly<{ claim_token: string; claim_expires_at: string; lifecycle_generation: number }>;

export type PostageOperationLocator = Readonly<{
  operationId: string;
  tenantId: string;
  shipmentId: string;
  updatedAt: string;
}>;

function opaqueProviderKey(keyDigest: string) {
  return `cs_ful_${createHash("sha256").update(`postage-provider/v1\n${keyDigest}`).digest("base64url")}`;
}

const operationColumns = `operation_key, operation_id, operation_kind, shipment_id, tenant_id, seller_account_id,
  key_digest, request_hash, target_key, provider_name, provider_mode, provider_idempotency_key, provider_result_json,
  request_json, status, lifecycle_generation, claim_token, claim_expires_at, closed_reason,
  provider_invoked, provider_shipment_id, provider_label_id, tracking_identifier,
  created_at, updated_at, completed_at`;

export async function findPostageOperationByDigest(
  db: PgQueryable,
  input: Readonly<{ tenantId: string; sellerAccountId: string; shipmentId: string; keyDigest: string }>,
) {
  const result = await db.query<PostageOperationAuthority>(
    `SELECT ${operationColumns}
     FROM fulfillment_postage_label_operations AS operation
     WHERE operation.tenant_id = $1
       AND operation.seller_account_id = $2
       AND operation.key_digest = $3
       AND operation.shipment_id = $4
       AND EXISTS (
         SELECT 1 FROM fulfillment_shipment_tenant_resolutions AS authority
         WHERE authority.shipment_id = operation.shipment_id
           AND authority.status = 'resolved'
           AND authority.tenant_id = operation.tenant_id
           AND authority.seller_account_id = operation.seller_account_id
       )`,
    [input.tenantId, input.sellerAccountId, input.keyDigest, input.shipmentId],
  );
  return result.rows[0] ?? null;
}

export async function listStalePostageOperationLocators(
  db: PgQueryable,
  input: Readonly<{
    staleBefore: string;
    afterUpdatedAt?: string | null;
    afterOperationId?: string | null;
    limit?: number;
  }>,
): Promise<readonly PostageOperationLocator[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const result = await db.query<{
    operation_id: string;
    tenant_id: string;
    shipment_id: string;
    updated_at: string;
  }>(
    `SELECT operation.operation_id,
            operation.tenant_id,
            operation.shipment_id,
            operation.updated_at
     FROM fulfillment_postage_label_operations AS operation
     JOIN fulfillment_shipment_tenant_resolutions AS authority
       ON authority.shipment_id = operation.shipment_id
      AND authority.status = 'resolved'
      AND authority.tenant_id = operation.tenant_id
      AND authority.seller_account_id = operation.seller_account_id
     WHERE operation.status IN ('reserved', 'invoking', 'provider-succeeded')
       AND operation.updated_at <= $1::timestamptz
       AND (
         $2::timestamptz IS NULL
         OR (operation.updated_at, operation.operation_id) > ($2::timestamptz, COALESCE($3, ''))
       )
     ORDER BY operation.updated_at ASC, operation.operation_id ASC
     LIMIT $4`,
    [input.staleBefore, input.afterUpdatedAt ?? null, input.afterOperationId ?? null, limit],
  );
  return result.rows.map((row) => ({
    operationId: row.operation_id,
    tenantId: row.tenant_id,
    shipmentId: row.shipment_id,
    updatedAt: row.updated_at,
  }));
}

export async function findPostageOperationByLocator(
  db: PgQueryable,
  locator: Pick<PostageOperationLocator, "operationId" | "tenantId" | "shipmentId">,
) {
  const result = await db.query<PostageOperationAuthority>(
    `SELECT ${operationColumns}
     FROM fulfillment_postage_label_operations AS operation
     WHERE operation.operation_id = $1
       AND operation.tenant_id = $2
       AND operation.shipment_id = $3
       AND EXISTS (
         SELECT 1 FROM fulfillment_shipment_tenant_resolutions AS authority
         WHERE authority.shipment_id = operation.shipment_id
           AND authority.status = 'resolved'
           AND authority.tenant_id = operation.tenant_id
           AND authority.seller_account_id = operation.seller_account_id
       )`,
    [locator.operationId, locator.tenantId, locator.shipmentId],
  );
  return result.rows[0] ?? null;
}

export async function quarantineShipmentTenantBinding(
  db: PgQueryable,
  input: Readonly<{ shipmentId: string; tenantId: string; reasonCode: string }>,
) {
  await db.query(
    `UPDATE fulfillment_shipment_tenant_resolutions
     SET status = 'quarantined', tenant_id = NULL, seller_account_id = NULL,
         reason_code = $3, resolved_at = now()
     WHERE shipment_id = $1 AND tenant_id = $2 AND status = 'resolved'`,
    [input.shipmentId, input.tenantId, input.reasonCode],
  );
}

export async function reservePostageOperation(
  db: PgQueryable,
  input: Readonly<{
    tenantId: string;
    sellerAccountId: string;
    shipmentId: string;
    keyDigest: string;
    requestHash: string;
    targetKey: string;
    operationKind: PostageOperationAuthority["operation_kind"];
    providerName: string;
    providerMode: string;
    request: unknown;
    now?: string;
  }>,
): Promise<Readonly<{ operation: PostageOperationAuthority; created: boolean; targetConflict: boolean }>> {
  const now = input.now ?? new Date().toISOString();
  const operationKey = `postage-operation/v1:${input.tenantId}:${input.sellerAccountId}:${input.keyDigest}`;
  const operationId = `pop_${randomUUID()}`;
  const inserted = await db.query<PostageOperationAuthority>(
    `INSERT INTO fulfillment_postage_label_operations (
       operation_key, operation_id, operation_kind, shipment_id, tenant_id, seller_account_id,
       key_digest, request_hash, target_key, provider_name, provider_mode, idempotency_key,
       provider_idempotency_key, request_json, status, lifecycle_generation,
       provider_invoked, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13::jsonb,'reserved',0,false,$14,$14)
     ON CONFLICT DO NOTHING
     RETURNING ${operationColumns}`,
    [
      operationKey,
      operationId,
      input.operationKind,
      input.shipmentId,
      input.tenantId,
      input.sellerAccountId,
      input.keyDigest,
      input.requestHash,
      input.targetKey,
      input.providerName,
      input.providerMode,
      opaqueProviderKey(input.keyDigest),
      JSON.stringify(input.request),
      now,
    ],
  );
  if (inserted.rows[0]) return { operation: inserted.rows[0], created: true, targetConflict: false };

  const existing = await findPostageOperationByDigest(db, input);
  if (existing) {
    if (
      existing.shipment_id !== input.shipmentId ||
      existing.operation_kind !== input.operationKind ||
      existing.target_key !== input.targetKey ||
      existing.request_hash !== input.requestHash
    ) {
      throw new Error("Idempotency key was already used for a different Shipment command.");
    }
    return { operation: existing, created: false, targetConflict: existing.closed_reason === "active-target-conflict" };
  }

  const loser = await db.query<PostageOperationAuthority>(
    `INSERT INTO fulfillment_postage_label_operations (
       operation_key, operation_id, operation_kind, shipment_id, tenant_id, seller_account_id,
       key_digest, request_hash, target_key, provider_name, provider_mode, idempotency_key,
       provider_idempotency_key, request_json, status, lifecycle_generation, closed_reason,
       provider_invoked, created_at, updated_at, completed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'',NULL,$12::jsonb,'failed-safe',0,
       'active-target-conflict',false,$13,$13,$13)
     ON CONFLICT DO NOTHING
     RETURNING ${operationColumns}`,
    [
      operationKey,
      operationId,
      input.operationKind,
      input.shipmentId,
      input.tenantId,
      input.sellerAccountId,
      input.keyDigest,
      input.requestHash,
      input.targetKey,
      input.providerName,
      input.providerMode,
      JSON.stringify(input.request),
      now,
    ],
  );
  const conflict = loser.rows[0] ?? (await findPostageOperationByDigest(db, input));
  if (!conflict) throw new Error("Unable to preserve the active-target conflict receipt.");
  return { operation: conflict, created: true, targetConflict: true };
}

export async function claimReservedPostageOperation(
  db: PgQueryable,
  operation: PostageOperationAuthority,
  leaseMs = 60_000,
): Promise<ClaimedPostageOperation | null> {
  const token = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const result = await db.query<ClaimedPostageOperation>(
    `UPDATE fulfillment_postage_label_operations
     SET claim_token = $4,
         lifecycle_generation = lifecycle_generation + 1,
         claim_expires_at = $5,
         updated_at = $6
     WHERE operation_id = $1 AND tenant_id = $2 AND lifecycle_generation = $3
       AND status = 'reserved'
       AND (claim_token IS NULL OR claim_expires_at <= $6)
     RETURNING ${operationColumns}`,
    [operation.operation_id, operation.tenant_id, operation.lifecycle_generation, token, expiresAt, now.toISOString()],
  );
  return result.rows[0] ?? null;
}

export async function claimPostageOperationForFinalization(
  db: PgQueryable,
  operation: PostageOperationAuthority,
  leaseMs = 60_000,
): Promise<ClaimedPostageOperation | null> {
  const token = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const result = await db.query<ClaimedPostageOperation>(
    `UPDATE fulfillment_postage_label_operations
     SET claim_token = $4,
         lifecycle_generation = lifecycle_generation + 1,
         claim_expires_at = $5,
         updated_at = $6
     WHERE operation_id = $1 AND tenant_id = $2 AND lifecycle_generation = $3
       AND status = 'provider-succeeded'
       AND (claim_token IS NULL OR claim_expires_at <= $6)
     RETURNING ${operationColumns}`,
    [operation.operation_id, operation.tenant_id, operation.lifecycle_generation, token, expiresAt, now.toISOString()],
  );
  return result.rows[0] ?? null;
}

export async function transitionPostageOperation(
  db: PgQueryable,
  input: Readonly<{
    claim: ClaimedPostageOperation;
    from: PostageOperationStatus;
    to: PostageOperationStatus;
    providerInvoked?: boolean;
    providerShipmentId?: string | null;
    providerLabelId?: string | null;
    trackingIdentifier?: string | null;
    providerResult?: unknown;
    closedReason?: string | null;
    completedAt?: string | null;
    now?: string;
  }>,
) {
  const now = input.now ?? new Date().toISOString();
  const result = await db.query<PostageOperationAuthority>(
    `UPDATE fulfillment_postage_label_operations
     SET status = $6,
         provider_invoked = COALESCE($7, provider_invoked),
         provider_shipment_id = COALESCE($8, provider_shipment_id),
         provider_label_id = COALESCE($9, provider_label_id),
         tracking_identifier = COALESCE($10, tracking_identifier),
         provider_result_json = COALESCE($11::jsonb, provider_result_json),
         closed_reason = COALESCE($12, closed_reason),
         completed_at = COALESCE($13, completed_at),
         updated_at = $5
     WHERE operation_id = $1 AND tenant_id = $2 AND claim_token = $3
       AND lifecycle_generation = $4 AND claim_expires_at > $5 AND status = $14
     RETURNING ${operationColumns}`,
    [
      input.claim.operation_id,
      input.claim.tenant_id,
      input.claim.claim_token,
      input.claim.lifecycle_generation,
      now,
      input.to,
      input.providerInvoked ?? null,
      input.providerShipmentId ?? null,
      input.providerLabelId ?? null,
      input.trackingIdentifier ?? null,
      input.providerResult === undefined ? null : JSON.stringify(input.providerResult),
      input.closedReason ?? null,
      input.completedAt ?? null,
      input.from,
    ],
  );
  return result.rows[0] ?? null;
}

export async function expireInvokingPostageOperation(db: PgQueryable, operationId: string, tenantId: string) {
  const result = await db.query<PostageOperationAuthority>(
    `UPDATE fulfillment_postage_label_operations
     SET status = 'ambiguous', closed_reason = 'invocation-outcome-unknown',
         claim_token = NULL, claim_expires_at = NULL, updated_at = now()
     WHERE operation_id = $1 AND tenant_id = $2 AND status = 'invoking' AND claim_expires_at <= now()
     RETURNING ${operationColumns}`,
    [operationId, tenantId],
  );
  return result.rows[0] ?? null;
}

export function postageOperationRecoveryStatus(operation: PostageOperationAuthority, now = new Date()) {
  switch (operation.status) {
    case "reserved":
    case "provider-succeeded":
      return "provider-pending";
    case "invoking":
      return operation.claim_token &&
        operation.claim_expires_at &&
        new Date(operation.claim_expires_at).getTime() > now.getTime()
        ? "provider-pending"
        : "ambiguous";
    case "ambiguous":
      return "ambiguous";
    case "effect-applied":
      return "succeeded";
    case "failed-safe":
      return operation.closed_reason === "active-target-conflict" ? "conflict" : "failed-safe";
  }
}
