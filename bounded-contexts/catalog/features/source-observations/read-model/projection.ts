import type { JsonValue } from "@chase-sets/primitives/json";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { SourceObservationNormalized } from "../domain/domain";

export function buildSourceObservationProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.source-observation.recorded": async (event) => {
      const data = event.data as {
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
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'observed', $11)
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
           updated_at = EXCLUDED.updated_at`,
        [
          data.observationId,
          data.providerKey,
          data.externalKey,
          data.sourceUrl,
          data.languageCode,
          data.sourceRecordHash,
          data.sourceUpdatedAt,
          data.observedAt,
          JSON.stringify(data.normalized),
          JSON.stringify(data.sourcePayload),
          event.timing.recordedAt,
        ],
      );
    },
    "catalog.source-observation.changed": async (event) => {
      const data = event.data as {
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

      await db.query(
        `UPDATE catalog_source_observations
         SET provider_key = $2,
             external_key = $3,
             source_url = $4,
             language_code = $5,
             source_record_hash = $6,
             source_updated_at = $7,
             observed_at = $8,
             normalized = $9,
             source_payload = $10,
             status = 'changed',
             status_reason = NULL,
             updated_at = $11
         WHERE observation_id = $1`,
        [
          data.observationId,
          data.providerKey,
          data.externalKey,
          data.sourceUrl,
          data.languageCode,
          data.sourceRecordHash,
          data.sourceUpdatedAt,
          data.observedAt,
          JSON.stringify(data.normalized),
          JSON.stringify(data.sourcePayload),
          event.timing.recordedAt,
        ],
      );
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
