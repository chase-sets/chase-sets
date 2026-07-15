import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  ProtectionCoverageRejectedV1Payload,
  ProtectionCoverageReservedV1Payload,
  ProtectionCoverageSettledV1Payload,
} from "@chase-sets/event-core/platform-coverage-facts";
import type { ProtectionCoverageTerminationPayload } from "../domain/protection-coverage";
import type { SettlementProtectionCoverageRecoveryPostedPayload } from "@chase-sets/event-core/public-event-payloads";

/**
 * Projects the Settlement-owned `settlement.protection-coverage.*` facts into the
 * ProtectionCoverage read models. Every write is guarded by
 * `last_stream_version` so redelivery is a no-op and a projection rebuild
 * converges to the same rows. Because all reservations for a currency fold into
 * one pool stream, stream versions are monotonic and ordering is preserved.
 */
export function buildProtectionCoverageProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "settlement.protection-coverage.reserved.v1": async (event) => {
      const data = event.data as ProtectionCoverageReservedV1Payload;
      await db.query(
        `INSERT INTO settlement_protection_coverage (
           coverage_id, remedy_id, support_request_id, currency_code,
           reserved_amount, consumed_amount, released_amount, status,
           refund_id, policy_version, reason_code, reserved_at, terminal_at,
           updated_at, last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, 0, 0, 'reserved', NULL, $6, NULL, $7, NULL, $7, $8)
         ON CONFLICT (coverage_id) DO UPDATE
         SET remedy_id = EXCLUDED.remedy_id,
             support_request_id = EXCLUDED.support_request_id,
             currency_code = EXCLUDED.currency_code,
             reserved_amount = EXCLUDED.reserved_amount,
             policy_version = EXCLUDED.policy_version,
             reserved_at = EXCLUDED.reserved_at,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE settlement_protection_coverage.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.coverageId,
          data.remedyId,
          data.supportRequestId,
          data.currencyCode,
          data.reservedAmount,
          data.policyVersion,
          data.occurredAt,
          event.streamVersion,
        ],
      );
    },
    "settlement.protection-coverage.settled.v1": async (event) => {
      const data = event.data as ProtectionCoverageSettledV1Payload;
      await db.query(
        `UPDATE settlement_protection_coverage
         SET status = 'settled',
             consumed_amount = $2,
             refund_id = $3,
             terminal_at = $4,
             updated_at = $4,
             last_stream_version = $5
         WHERE coverage_id = $1
           AND last_stream_version < $5`,
        [data.coverageId, data.allocation.platformFundedAmount, data.refundId, data.occurredAt, event.streamVersion],
      );
    },
    "settlement.protection-coverage.released.v1": async (event) => {
      await applyTermination(db, event.data as ProtectionCoverageTerminationPayload, event.streamVersion, "released");
    },
    "settlement.protection-coverage.expired.v1": async (event) => {
      await applyTermination(db, event.data as ProtectionCoverageTerminationPayload, event.streamVersion, "expired");
    },
    "settlement.protection-coverage.rejected.v1": async (event) => {
      const data = event.data as ProtectionCoverageRejectedV1Payload;
      await db.query(
        `INSERT INTO settlement_protection_coverage_rejections (
           coverage_id, remedy_id, support_request_id, requested_amount,
           currency_code, reason_code, idempotency_key, rejected_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (coverage_id, idempotency_key) DO NOTHING`,
        [
          data.coverageId,
          data.remedyId,
          data.supportRequestId,
          data.requestedAmount,
          data.currencyCode,
          data.reasonCode,
          data.idempotencyKey,
          data.occurredAt,
        ],
      );
    },
    "settlement.protection-coverage.recovery-posted.v1": async (event) => {
      const data = event.data as SettlementProtectionCoverageRecoveryPostedPayload;
      await db.query(
        `INSERT INTO settlement_protection_coverage_recoveries (
           recovery_id, coverage_id, remedy_id, recovered_item_id, return_shipment_id,
           recovery_type, gross_amount, cost_amount, net_amount, currency_code,
           policy_version, evidence_references, causation_id, recovered_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
         ON CONFLICT (recovery_id) DO NOTHING`,
        [
          data.recoveryId,
          data.coverageId,
          data.remedyId,
          data.recoveredItemId,
          data.returnShipmentId,
          data.recoveryType,
          data.grossAmount,
          data.costAmount,
          data.netAmount,
          data.currencyCode,
          data.policyVersion,
          JSON.stringify(data.evidenceReferences),
          data.causationId,
          data.occurredAt,
        ],
      );
      await db.query(
        `UPDATE settlement_protection_coverage
         SET recovered_gross_amount = recovered_gross_amount + $2,
             recovery_cost_amount = recovery_cost_amount + $3,
             recovered_net_amount = recovered_net_amount + $4,
             updated_at = $5,
             last_stream_version = $6
         WHERE coverage_id = $1 AND last_stream_version < $6`,
        [data.coverageId, data.grossAmount, data.costAmount, data.netAmount, data.occurredAt, event.streamVersion],
      );
    },
  };
}

async function applyTermination(
  db: PgQueryable,
  data: ProtectionCoverageTerminationPayload,
  streamVersion: number,
  status: "released" | "expired",
): Promise<void> {
  await db.query(
    `UPDATE settlement_protection_coverage
     SET status = $2,
         released_amount = $3,
         reason_code = $4,
         terminal_at = $5,
         updated_at = $5,
         last_stream_version = $6
     WHERE coverage_id = $1
       AND last_stream_version < $6
       AND status = 'reserved'`,
    [data.coverageId, status, data.releasedAmount, data.reasonCode, data.occurredAt, streamVersion],
  );
}
