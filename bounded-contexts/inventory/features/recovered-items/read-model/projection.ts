import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { RecoveredItemDispositionFact, RecoveredItemValueFact } from "../domain/recovered-item";

const eventTypes = [
  "inventory.recovered-item.created.v1",
  "inventory.recovered-item.identified.v1",
  "inventory.recovered-item.inspection-completed.v1",
  "inventory.recovered-item.authenticity-review-required.v1",
  "inventory.recovered-item.authenticity-review-completed.v1",
  "inventory.recovered-item.disposition-authority-recorded.v1",
  "inventory.recovered-item.disposition-decided.v1",
  "inventory.recovered-item.sellable.v1",
  "inventory.recovered-item.transferred.v1",
  "inventory.recovered-item.disposed.v1",
  "inventory.recovered-item.value-reported.v1",
  "inventory.recovered-item.source-corrected.v1",
  "inventory.recovered-item.merged.v1",
] as const;

function evidenceFrom(data: unknown): readonly string[] {
  if (!data || typeof data !== "object" || !("evidenceReferences" in data)) {
    return [];
  }
  const value = (data as { evidenceReferences?: unknown }).evidenceReferences;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

async function audit(db: PgQueryable, event: Parameters<ProjectorHandlerMap[string]>[0], recoveredItemId: string) {
  await db.query(
    `INSERT INTO inventory_recovered_item_audit (
       event_id, recovered_item_id, action, actor_user_id, evidence_references,
       payload, occurred_at, stream_version
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      event.id,
      recoveredItemId,
      event.type,
      event.audit.performedByUserId,
      JSON.stringify(evidenceFrom(event.data)),
      JSON.stringify(event.data),
      event.timing.occurredAt,
      event.streamVersion,
    ],
  );
}

export function buildInventoryRecoveredItemProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const handlers: ProjectorHandlerMap = {
    "inventory.recovered-item.created.v1": async (event) => {
      const data = event.data as {
        recoveredItemId: string;
        returnShipmentId: string;
        remedyId: string;
        custodyLocationId: string;
        custodyIdentifier: string;
        evidenceReferences: readonly string[];
        observedItemReference: string | null;
        hasDiscrepancy: boolean;
        receivedAt: string;
      };
      const status =
        data.observedItemReference === null || data.hasDiscrepancy ? "awaiting-identification" : "quarantined";
      await db.query(
        `INSERT INTO inventory_recovered_items (
           recovered_item_id, return_shipment_id, remedy_id, custody_location_id,
           custody_identifier, evidence_references, status, received_at, updated_at, last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
         ON CONFLICT (recovered_item_id) DO UPDATE
         SET return_shipment_id = EXCLUDED.return_shipment_id,
             remedy_id = EXCLUDED.remedy_id,
             custody_location_id = EXCLUDED.custody_location_id,
             custody_identifier = EXCLUDED.custody_identifier,
             evidence_references = EXCLUDED.evidence_references,
             status = EXCLUDED.status,
             received_at = EXCLUDED.received_at,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE inventory_recovered_items.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.recoveredItemId,
          data.returnShipmentId,
          data.remedyId,
          data.custodyLocationId,
          data.custodyIdentifier,
          JSON.stringify(data.evidenceReferences),
          status,
          data.receivedAt,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
      await audit(db, event, data.recoveredItemId);
    },
    "inventory.recovered-item.identified.v1": async (event) => {
      const data = event.data as { catalogItemId: string; productId: string; selectedOptions: readonly unknown[] };
      const recoveredItemId = event.streamId.replace("inventory.recovered-item-", "");
      await db.query(
        `UPDATE inventory_recovered_items
         SET catalog_item_id = $2, product_id = $3, selected_options = $4::jsonb,
             status = 'quarantined', updated_at = $5, last_stream_version = $6
         WHERE recovered_item_id = $1 AND last_stream_version < $6`,
        [
          recoveredItemId,
          data.catalogItemId,
          data.productId,
          JSON.stringify(data.selectedOptions),
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
      await audit(db, event, recoveredItemId);
    },
    "inventory.recovered-item.inspection-completed.v1": async (event) => {
      const data = event.data as { conditionGrade: string };
      const recoveredItemId = event.streamId.replace("inventory.recovered-item-", "");
      await db.query(
        `UPDATE inventory_recovered_items
         SET condition_grade = $2, status = 'inspection-complete', updated_at = $3, last_stream_version = $4
         WHERE recovered_item_id = $1 AND last_stream_version < $4`,
        [recoveredItemId, data.conditionGrade, event.timing.recordedAt, event.streamVersion],
      );
      await audit(db, event, recoveredItemId);
    },
    "inventory.recovered-item.authenticity-review-required.v1": async (event) => {
      const recoveredItemId = event.streamId.replace("inventory.recovered-item-", "");
      await db.query(
        `UPDATE inventory_recovered_items
         SET authenticity_review_required = true, authenticity_outcome = NULL,
             status = 'authenticity-review', updated_at = $2, last_stream_version = $3
         WHERE recovered_item_id = $1 AND last_stream_version < $3`,
        [recoveredItemId, event.timing.recordedAt, event.streamVersion],
      );
      await audit(db, event, recoveredItemId);
    },
    "inventory.recovered-item.authenticity-review-completed.v1": async (event) => {
      const data = event.data as { outcome: string };
      const recoveredItemId = event.streamId.replace("inventory.recovered-item-", "");
      await db.query(
        `UPDATE inventory_recovered_items
         SET authenticity_outcome = $2, status = 'inspection-complete', updated_at = $3, last_stream_version = $4
         WHERE recovered_item_id = $1 AND last_stream_version < $4`,
        [recoveredItemId, data.outcome, event.timing.recordedAt, event.streamVersion],
      );
      await audit(db, event, recoveredItemId);
    },
    "inventory.recovered-item.disposition-authority-recorded.v1": async (event) => {
      const recoveredItemId = event.streamId.replace("inventory.recovered-item-", "");
      await db.query(
        `UPDATE inventory_recovered_items
         SET disposition_authority = $2::jsonb,
             status = CASE WHEN condition_grade IS NOT NULL AND
               (authenticity_review_required = false OR authenticity_outcome IS NOT NULL)
               THEN 'ready-for-disposition' ELSE status END,
             updated_at = $3, last_stream_version = $4
         WHERE recovered_item_id = $1 AND last_stream_version < $4`,
        [recoveredItemId, JSON.stringify(event.data), event.timing.recordedAt, event.streamVersion],
      );
      await audit(db, event, recoveredItemId);
    },
    "inventory.recovered-item.disposition-decided.v1": async (event) => {
      const data = event.data as {
        disposition: string;
        targetAccountId: string | null;
        storageLocationId: string | null;
      };
      const recoveredItemId = event.streamId.replace("inventory.recovered-item-", "");
      await db.query(
        `UPDATE inventory_recovered_items
         SET disposition = $2, target_account_id = $3, storage_location_id = $4,
             updated_at = $5, last_stream_version = $6
         WHERE recovered_item_id = $1 AND last_stream_version < $6`,
        [
          recoveredItemId,
          data.disposition,
          data.targetAccountId,
          data.storageLocationId,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
      await audit(db, event, recoveredItemId);
    },
    "inventory.recovered-item.sellable.v1": async (event) => applyDispositionStatus(db, event, "sellable"),
    "inventory.recovered-item.transferred.v1": async (event) => applyDispositionStatus(db, event, "transferred"),
    "inventory.recovered-item.disposed.v1": async (event) => applyDispositionStatus(db, event, "disposed"),
    "inventory.recovered-item.value-reported.v1": async (event) => {
      const data = event.data as RecoveredItemValueFact;
      await db.query(
        `INSERT INTO inventory_recovered_item_values (
           recovery_id, recovered_item_id, remedy_id, recovery_type, gross_amount,
           cost_amount, currency_code, policy_version, evidence_references, recorded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         ON CONFLICT (recovery_id) DO NOTHING`,
        [
          data.recoveryId,
          data.recoveredItemId,
          data.remedyId,
          data.recoveryType,
          data.grossAmount,
          data.costAmount,
          data.currencyCode,
          data.policyVersion,
          JSON.stringify(data.evidenceReferences),
          data.recordedAt,
        ],
      );
      await audit(db, event, data.recoveredItemId);
    },
    "inventory.recovered-item.source-corrected.v1": async (event) => {
      const data = event.data as { correctedReturnShipmentId: string };
      const recoveredItemId = event.streamId.replace("inventory.recovered-item-", "");
      await db.query(
        `UPDATE inventory_recovered_items
         SET return_shipment_id = $2, updated_at = $3, last_stream_version = $4
         WHERE recovered_item_id = $1 AND last_stream_version < $4`,
        [recoveredItemId, data.correctedReturnShipmentId, event.timing.recordedAt, event.streamVersion],
      );
      await audit(db, event, recoveredItemId);
    },
    "inventory.recovered-item.merged.v1": async (event) => {
      const data = event.data as { canonicalRecoveredItemId: string };
      const recoveredItemId = event.streamId.replace("inventory.recovered-item-", "");
      await db.query(
        `UPDATE inventory_recovered_items
         SET status = 'merged', merged_into_recovered_item_id = $2,
             updated_at = $3, last_stream_version = $4
         WHERE recovered_item_id = $1 AND last_stream_version < $4`,
        [recoveredItemId, data.canonicalRecoveredItemId, event.timing.recordedAt, event.streamVersion],
      );
      await audit(db, event, recoveredItemId);
    },
  };

  return Object.fromEntries(eventTypes.map((eventType) => [eventType, handlers[eventType]!])) as ProjectorHandlerMap;
}

async function applyDispositionStatus(
  db: PgQueryable,
  event: Parameters<ProjectorHandlerMap[string]>[0],
  status: "sellable" | "transferred" | "disposed",
) {
  const data = event.data as RecoveredItemDispositionFact;
  await db.query(
    `UPDATE inventory_recovered_items
     SET status = $2, sellable_at = CASE WHEN $2 = 'sellable' THEN $3::timestamptz ELSE sellable_at END,
         updated_at = $3, last_stream_version = $4
     WHERE recovered_item_id = $1 AND last_stream_version < $4`,
    [data.recoveredItemId, status, data.occurredAt, event.streamVersion],
  );
  await audit(db, event, data.recoveredItemId);
}
