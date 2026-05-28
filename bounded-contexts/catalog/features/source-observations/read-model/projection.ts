import type { JsonValue } from "@chase-sets/primitives/json";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { SourceObservationNormalized, SourceObservationStatus } from "../domain/domain";

type ObservationProjectionData = {
  observationId: string;
  providerKey: string;
  externalKey: string;
  sourceUrl: string;
  languageCode: string;
  sourceRecordHash: string;
  sourceUpdatedAt: string | null;
  observedAt: string;
  normalized: SourceObservationNormalized;
  sourcePayload: JsonValue;
};

export function buildSourceObservationProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.source-observation.recorded": async (event) => {
      const data = event.data as ObservationProjectionData;

      await upsertObservation(db, {
        data,
        status: "observed",
        statusReason: null,
        promotedCatalogItemId: null,
        promotedAt: null,
        updatedAt: event.timing.recordedAt,
        writePromotionState: true,
      });
    },
    "catalog.source-observation.changed": async (event) => {
      const data = event.data as ObservationProjectionData;

      await upsertObservation(db, {
        data,
        status: "changed",
        statusReason: null,
        promotedCatalogItemId: null,
        promotedAt: null,
        updatedAt: event.timing.recordedAt,
        writePromotionState: false,
      });
    },
    "catalog.source-observation.refreshed": async (event) => {
      const data = event.data as ObservationProjectionData & {
        status: SourceObservationStatus;
        statusReason: string | null;
        promotedCatalogItemId: string | null;
        promotedAt: string | null;
      };

      await upsertObservation(db, {
        data,
        status: data.status,
        statusReason: data.statusReason,
        promotedCatalogItemId: data.promotedCatalogItemId,
        promotedAt: data.promotedAt,
        updatedAt: event.timing.recordedAt,
        writePromotionState: true,
      });
    },
    "catalog.source-observation.promoted": async (event) => {
      const observationId = extractObservationId(event.streamId);
      const data = event.data as { catalogItemId: string; promotedAt: string };

      await db.query(
        `UPDATE catalog_source_observations
         SET status = 'promoted',
             promoted_catalog_item_id = $2,
             promoted_at = $3,
             status_reason = NULL,
             updated_at = $4
         WHERE observation_id = $1`,
        [observationId, data.catalogItemId, data.promotedAt, event.timing.recordedAt],
      );
    },
    "catalog.source-observation.rejected": async (event) => {
      const observationId = extractObservationId(event.streamId);
      const data = event.data as { reason: string };

      await db.query(
        `UPDATE catalog_source_observations
         SET status = 'rejected',
             status_reason = $2,
             updated_at = $3
         WHERE observation_id = $1`,
        [observationId, data.reason, event.timing.recordedAt],
      );
    },
  };
}

function extractObservationId(streamId: string): string {
  const prefix = "catalog.source-observation-";
  if (!streamId.startsWith(prefix)) {
    throw new Error(`Stream ID "${streamId}" does not start with prefix "${prefix}".`);
  }

  return streamId.slice(prefix.length);
}

async function upsertObservation(
  db: PgQueryable,
  input: {
    data: ObservationProjectionData;
    status: SourceObservationStatus;
    statusReason: string | null;
    promotedCatalogItemId: string | null;
    promotedAt: string | null;
    updatedAt: string;
    writePromotionState: boolean;
  },
) {
  const promotionConflictUpdates = input.writePromotionState
    ? `promoted_catalog_item_id = EXCLUDED.promoted_catalog_item_id,
           promoted_at = EXCLUDED.promoted_at,`
    : "";

  await db.query(
    `INSERT INTO catalog_source_observations (
       observation_id,
       provider_key,
       external_key,
       source_url,
       language_code,
       source_record_hash,
       source_updated_at,
       observed_at,
       normalized,
       source_payload,
       status,
       status_reason,
       promoted_catalog_item_id,
       promoted_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (observation_id) DO UPDATE SET
       provider_key = EXCLUDED.provider_key,
       external_key = EXCLUDED.external_key,
       source_url = EXCLUDED.source_url,
       language_code = EXCLUDED.language_code,
       source_record_hash = EXCLUDED.source_record_hash,
       source_updated_at = EXCLUDED.source_updated_at,
       observed_at = EXCLUDED.observed_at,
       normalized = EXCLUDED.normalized,
       source_payload = EXCLUDED.source_payload,
       status = EXCLUDED.status,
       status_reason = EXCLUDED.status_reason,
       ${promotionConflictUpdates}
       updated_at = EXCLUDED.updated_at`,
    [
      input.data.observationId,
      input.data.providerKey,
      input.data.externalKey,
      input.data.sourceUrl,
      input.data.languageCode,
      input.data.sourceRecordHash,
      input.data.sourceUpdatedAt,
      input.data.observedAt,
      JSON.stringify(input.data.normalized),
      JSON.stringify(input.data.sourcePayload),
      input.status,
      input.statusReason,
      input.promotedCatalogItemId,
      input.promotedAt,
      input.updatedAt,
    ],
  );
}
