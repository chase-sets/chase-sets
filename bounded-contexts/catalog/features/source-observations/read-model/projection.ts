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
  sourceProfileKey?: string;
  sourceProfileVersion?: string;
  sourceMappingFingerprint?: string;
  normalized: SourceObservationNormalized;
  sourcePayload: JsonValue;
  promotionProfileKey?: string | null;
  promotionProfileVersion?: string | null;
  promotionPlanFingerprint?: string | null;
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
      const data = event.data as {
        catalogItemId: string;
        promotedAt: string;
        promotionProfileKey?: string;
        promotionProfileVersion?: string;
        promotionPlanFingerprint?: string;
      };

      await db.query(
        `UPDATE catalog_source_observations
         SET status = 'promoted',
             promoted_catalog_item_id = $2,
             promoted_at = $3,
             status_reason = NULL,
             promotion_profile_key = $4,
             promotion_profile_version = $5,
             promotion_plan_fingerprint = $6,
             updated_at = $7
         WHERE observation_id = $1`,
        [
          observationId,
          data.catalogItemId,
          data.promotedAt,
          requireProjectionProfileMarker(data.promotionProfileKey, "Promotion profile key").toLowerCase(),
          requireProjectionProfileMarker(data.promotionProfileVersion, "Promotion profile version"),
          requireProjectionProfileMarker(data.promotionPlanFingerprint, "Promotion plan fingerprint"),
          event.timing.recordedAt,
        ],
      );
    },
    "catalog.source-observation.promotion-plan-recorded": async (event) => {
      const observationId = extractObservationId(event.streamId);
      const data = event.data as {
        catalogItemId: string;
        promotionProfileKey: string;
        promotionProfileVersion: string;
        promotionPlanFingerprint: string;
      };

      await db.query(
        `UPDATE catalog_source_observations
         SET promoted_catalog_item_id = $2,
             promotion_profile_key = $3,
             promotion_profile_version = $4,
             promotion_plan_fingerprint = $5,
             updated_at = $6
         WHERE observation_id = $1`,
        [
          observationId,
          data.catalogItemId,
          data.promotionProfileKey,
          data.promotionProfileVersion,
          data.promotionPlanFingerprint,
          event.timing.recordedAt,
        ],
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
           promoted_at = EXCLUDED.promoted_at,
           promotion_profile_key = EXCLUDED.promotion_profile_key,
           promotion_profile_version = EXCLUDED.promotion_profile_version,
           promotion_plan_fingerprint = EXCLUDED.promotion_plan_fingerprint,`
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
       source_profile_key,
       source_profile_version,
       source_mapping_fingerprint,
       normalized,
       source_payload,
       status,
       status_reason,
       promoted_catalog_item_id,
       promoted_at,
       promotion_profile_key,
       promotion_profile_version,
       promotion_plan_fingerprint,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (observation_id) DO UPDATE SET
       provider_key = EXCLUDED.provider_key,
       external_key = EXCLUDED.external_key,
       source_url = EXCLUDED.source_url,
       language_code = EXCLUDED.language_code,
       source_record_hash = EXCLUDED.source_record_hash,
       source_updated_at = EXCLUDED.source_updated_at,
       observed_at = EXCLUDED.observed_at,
       source_profile_key = EXCLUDED.source_profile_key,
       source_profile_version = EXCLUDED.source_profile_version,
       source_mapping_fingerprint = EXCLUDED.source_mapping_fingerprint,
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
      requireProjectionProfileMarker(
        input.data.sourceProfileKey,
        "Source observation source profile key",
      ).toLowerCase(),
      requireProjectionProfileMarker(input.data.sourceProfileVersion, "Source observation source profile version"),
      requireProjectionProfileMarker(
        input.data.sourceMappingFingerprint,
        "Source observation source mapping fingerprint",
      ),
      JSON.stringify(input.data.normalized),
      JSON.stringify(input.data.sourcePayload),
      input.status,
      input.statusReason,
      input.promotedCatalogItemId,
      input.promotedAt,
      input.data.promotionProfileKey ?? null,
      input.data.promotionProfileVersion ?? null,
      input.data.promotionPlanFingerprint ?? null,
      input.updatedAt,
    ],
  );
}

function requireProjectionProfileMarker(value: string | null | undefined, label: string): string {
  const marker = value?.trim();
  if (!marker) {
    throw new Error(`${label} is required for Source Observation projection.`);
  }
  if (marker.toLowerCase() === "legacy") {
    throw new Error(`${label} cannot use the retired legacy marker.`);
  }
  return marker;
}
