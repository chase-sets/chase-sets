import type { JsonValue } from "@chase-sets/primitives/json";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { SourceObservationNormalized, SourceObservationStatus } from "../domain/domain";
import {
  decodeSourceObservationPayloadChunks,
  SOURCE_OBSERVATION_PAYLOAD_ENCODING,
} from "../domain/source-observation-payload-chunks";
import { buildCatalogMergeCandidateProjectionHandlers } from "./catalog-merge-candidate-projection";
import {
  readSourceObservationIntegrationScopeKey,
  rebuildSourceObservationIntegrationScopeSummaries,
} from "./integration-scope-summary";

const SOURCE_OBSERVATION_STREAM_PREFIX = "catalog.source-observation-";

type ObservationProjectionData = {
  observationId: string;
  syncRunId?: string | null;
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

type ObservationRecordEventType =
  | "catalog.source-observation.recorded"
  | "catalog.source-observation.changed"
  | "catalog.source-observation.refreshed";

type ChunkedObservationProjectionData = Omit<ObservationProjectionData, "sourcePayload"> & {
  sourcePayloadEncoding: typeof SOURCE_OBSERVATION_PAYLOAD_ENCODING;
  sourcePayloadChunkCount: number;
};

type SourcePayloadChunkProjectionData = {
  observationId: string;
  sourceRecordHash: string;
  chunkIndex: number;
  chunkCount: number;
  encodedPayload: string;
};

export function buildSourceObservationProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    ...buildCatalogMergeCandidateProjectionHandlers(db),
    "catalog.source-observation.recorded": async (event) => {
      await projectObservationRecordEvent(
        db,
        "catalog.source-observation.recorded",
        event.data as ObservationProjectionData | ChunkedObservationProjectionData,
        event.timing.recordedAt,
      );
    },
    "catalog.source-observation.changed": async (event) => {
      await projectObservationRecordEvent(
        db,
        "catalog.source-observation.changed",
        event.data as ObservationProjectionData | ChunkedObservationProjectionData,
        event.timing.recordedAt,
      );
    },
    "catalog.source-observation.refreshed": async (event) => {
      await projectObservationRecordEvent(
        db,
        "catalog.source-observation.refreshed",
        event.data as ObservationProjectionData | ChunkedObservationProjectionData,
        event.timing.recordedAt,
      );
    },
    "catalog.source-observation.source-payload-chunk-recorded": async (event) => {
      await projectSourcePayloadChunk(db, event.data as SourcePayloadChunkProjectionData, event.timing.recordedAt);
    },
    "catalog.source-observation.promoted": async (event) => {
      const observationId = extractIdFromStreamId(event.streamId, SOURCE_OBSERVATION_STREAM_PREFIX);
      const data = event.data as {
        catalogItemId: string;
        promotedAt: string;
        promotionProfileKey?: string;
        promotionProfileVersion?: string;
        promotionPlanFingerprint?: string;
      };

      await projectObservationScopeChange(db, observationId, event.timing.recordedAt, () =>
        db.query(
          `UPDATE catalog_source_observations
             SET status = 'promoted',
                 promoted_catalog_item_id = $2,
                 promoted_reference_record_id = NULL,
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
        ),
      );
    },
    "catalog.source-observation.reference-promoted": async (event) => {
      const observationId = extractIdFromStreamId(event.streamId, SOURCE_OBSERVATION_STREAM_PREFIX);
      const data = event.data as {
        referenceRecordId: string;
        promotedAt: string;
        promotionProfileKey?: string;
        promotionProfileVersion?: string;
        promotionPlanFingerprint?: string;
      };

      await projectObservationScopeChange(db, observationId, event.timing.recordedAt, () =>
        db.query(
          `UPDATE catalog_source_observations
             SET status = 'promoted',
                 promoted_catalog_item_id = NULL,
                 promoted_reference_record_id = $2,
                 promoted_at = $3,
                 status_reason = NULL,
                 promotion_profile_key = $4,
                 promotion_profile_version = $5,
                 promotion_plan_fingerprint = $6,
                 updated_at = $7
             WHERE observation_id = $1`,
          [
            observationId,
            data.referenceRecordId,
            data.promotedAt,
            requireProjectionProfileMarker(data.promotionProfileKey, "Reference promotion profile key").toLowerCase(),
            requireProjectionProfileMarker(data.promotionProfileVersion, "Reference promotion profile version"),
            requireProjectionProfileMarker(data.promotionPlanFingerprint, "Reference promotion plan fingerprint"),
            event.timing.recordedAt,
          ],
        ),
      );
    },
    "catalog.source-observation.promotion-plan-recorded": async (event) => {
      const observationId = extractIdFromStreamId(event.streamId, SOURCE_OBSERVATION_STREAM_PREFIX);
      const data = event.data as {
        catalogItemId: string;
        promotionProfileKey: string;
        promotionProfileVersion: string;
        promotionPlanFingerprint: string;
      };

      await db.query(
        `UPDATE catalog_source_observations
         SET promoted_catalog_item_id = $2,
             promoted_reference_record_id = NULL,
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
    "catalog.source-observation.reference-promotion-plan-recorded": async (event) => {
      const observationId = extractIdFromStreamId(event.streamId, SOURCE_OBSERVATION_STREAM_PREFIX);
      const data = event.data as {
        referenceRecordId: string;
        promotionProfileKey: string;
        promotionProfileVersion: string;
        promotionPlanFingerprint: string;
      };

      await db.query(
        `UPDATE catalog_source_observations
         SET promoted_catalog_item_id = NULL,
             promoted_reference_record_id = $2,
             promotion_profile_key = $3,
             promotion_profile_version = $4,
             promotion_plan_fingerprint = $5,
             updated_at = $6
         WHERE observation_id = $1`,
        [
          observationId,
          data.referenceRecordId,
          data.promotionProfileKey,
          data.promotionProfileVersion,
          data.promotionPlanFingerprint,
          event.timing.recordedAt,
        ],
      );
    },
    "catalog.source-observation.rejected": async (event) => {
      const observationId = extractIdFromStreamId(event.streamId, SOURCE_OBSERVATION_STREAM_PREFIX);
      const data = event.data as { reason: string };

      await projectObservationScopeChange(db, observationId, event.timing.recordedAt, () =>
        db.query(
          `UPDATE catalog_source_observations
             SET status = 'rejected',
                 status_reason = $2,
                 updated_at = $3
             WHERE observation_id = $1`,
          [observationId, data.reason, event.timing.recordedAt],
        ),
      );
    },
    "catalog.source-observation.deferred": async (event) => {
      const observationId = extractIdFromStreamId(event.streamId, SOURCE_OBSERVATION_STREAM_PREFIX);
      const data = event.data as { reason: string; reviewStatus: "observed" | "changed" };

      await projectObservationScopeChange(db, observationId, event.timing.recordedAt, () =>
        db.query(
          `UPDATE catalog_source_observations
             SET status = $2,
                 status_reason = $3,
                 updated_at = $4
             WHERE observation_id = $1`,
          [observationId, data.reviewStatus, data.reason, event.timing.recordedAt],
        ),
      );
    },
  };
}

type RefreshedObservationProjectionData = ObservationProjectionData & {
  status: SourceObservationStatus;
  statusReason: string | null;
  promotedCatalogItemId: string | null;
  promotedReferenceRecordId: string | null;
  promotedAt: string | null;
};

type PayloadAssemblyRow = {
  record_event_type: string;
  record_data: unknown;
  encoded_chunks: unknown;
};

async function projectObservationRecordEvent(
  db: PgQueryable,
  eventType: ObservationRecordEventType,
  data: ObservationProjectionData | ChunkedObservationProjectionData,
  recordedAt: string,
): Promise<void> {
  if ("sourcePayload" in data) {
    await projectMaterializedObservation(db, eventType, data, recordedAt);
    return;
  }

  if (
    data.sourcePayloadEncoding !== SOURCE_OBSERVATION_PAYLOAD_ENCODING ||
    !Number.isInteger(data.sourcePayloadChunkCount) ||
    data.sourcePayloadChunkCount < 1
  ) {
    throw new Error("Source Observation payload header has an unsupported encoding or chunk count.");
  }

  await db.query(
    `INSERT INTO catalog_source_observation_payload_assemblies (
       observation_id,
       source_record_hash,
       record_event_type,
       record_data,
       expected_chunk_count,
       encoded_chunks,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6)
     ON CONFLICT (observation_id) DO UPDATE SET
       source_record_hash = EXCLUDED.source_record_hash,
       record_event_type = EXCLUDED.record_event_type,
       record_data = EXCLUDED.record_data,
       expected_chunk_count = EXCLUDED.expected_chunk_count,
       encoded_chunks = '[]'::jsonb,
       updated_at = EXCLUDED.updated_at`,
    [
      data.observationId,
      data.sourceRecordHash,
      eventType,
      JSON.stringify(data),
      data.sourcePayloadChunkCount,
      recordedAt,
    ],
  );
}

async function projectSourcePayloadChunk(
  db: PgQueryable,
  data: SourcePayloadChunkProjectionData,
  recordedAt: string,
): Promise<void> {
  if (!Number.isInteger(data.chunkIndex) || data.chunkIndex < 0 || !Number.isInteger(data.chunkCount)) {
    throw new Error("Source Observation payload chunk has an invalid position.");
  }

  const result = await db.query<PayloadAssemblyRow>(
    `UPDATE catalog_source_observation_payload_assemblies
       SET encoded_chunks = encoded_chunks || jsonb_build_array($5::text),
           updated_at = $6
     WHERE observation_id = $1
       AND source_record_hash = $2
       AND jsonb_array_length(encoded_chunks) = $3
       AND expected_chunk_count = $4
     RETURNING record_event_type, record_data, encoded_chunks`,
    [data.observationId, data.sourceRecordHash, data.chunkIndex, data.chunkCount, data.encodedPayload, recordedAt],
  );
  const assembly = result.rows[0];
  if (!assembly) {
    throw new Error("Source Observation payload chunk is missing its header or is out of order.");
  }
  if (data.chunkIndex + 1 < data.chunkCount) {
    return;
  }

  const eventType = requireObservationRecordEventType(assembly.record_event_type);
  const recordData = requireChunkedObservationProjectionData(assembly.record_data);
  const encodedChunks = requireEncodedChunks(assembly.encoded_chunks, data.chunkCount);
  const { sourcePayloadEncoding: _encoding, sourcePayloadChunkCount: _count, ...header } = recordData;
  const materialized = {
    ...header,
    sourcePayload: decodeSourceObservationPayloadChunks(encodedChunks),
  } as ObservationProjectionData;

  await projectMaterializedObservation(db, eventType, materialized, recordedAt);
  await db.query("DELETE FROM catalog_source_observation_payload_assemblies WHERE observation_id = $1", [
    data.observationId,
  ]);
}

async function projectMaterializedObservation(
  db: PgQueryable,
  eventType: ObservationRecordEventType,
  data: ObservationProjectionData,
  recordedAt: string,
): Promise<void> {
  const input =
    eventType === "catalog.source-observation.refreshed"
      ? (() => {
          const refreshed = data as RefreshedObservationProjectionData;
          return {
            status: refreshed.status,
            statusReason: refreshed.statusReason,
            promotedCatalogItemId: refreshed.promotedCatalogItemId,
            promotedReferenceRecordId: refreshed.promotedReferenceRecordId ?? null,
            promotedAt: refreshed.promotedAt,
            writePromotionState: true,
          };
        })()
      : {
          status: eventType === "catalog.source-observation.recorded" ? ("observed" as const) : ("changed" as const),
          statusReason: null,
          promotedCatalogItemId: null,
          promotedReferenceRecordId: null,
          promotedAt: null,
          writePromotionState: eventType === "catalog.source-observation.recorded",
        };

  await projectObservationScopeChange(db, data.observationId, recordedAt, () =>
    upsertObservation(db, {
      data,
      ...input,
      updatedAt: recordedAt,
    }),
  );
}

function requireObservationRecordEventType(value: string): ObservationRecordEventType {
  if (
    value === "catalog.source-observation.recorded" ||
    value === "catalog.source-observation.changed" ||
    value === "catalog.source-observation.refreshed"
  ) {
    return value;
  }
  throw new Error(`Unsupported Source Observation record event type '${value}'.`);
}

function requireChunkedObservationProjectionData(value: unknown): ChunkedObservationProjectionData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Source Observation payload assembly is missing record data.");
  }
  return value as ChunkedObservationProjectionData;
}

function requireEncodedChunks(value: unknown, expectedCount: number): readonly string[] {
  if (!Array.isArray(value) || value.length !== expectedCount || !value.every((chunk) => typeof chunk === "string")) {
    throw new Error("Source Observation payload assembly is incomplete.");
  }
  return value;
}

async function upsertObservation(
  db: PgQueryable,
  input: {
    data: ObservationProjectionData;
    status: SourceObservationStatus;
    statusReason: string | null;
    promotedCatalogItemId: string | null;
    promotedReferenceRecordId: string | null;
    promotedAt: string | null;
    updatedAt: string;
    writePromotionState: boolean;
  },
) {
  const promotionConflictUpdates = input.writePromotionState
    ? `promoted_catalog_item_id = EXCLUDED.promoted_catalog_item_id,
           promoted_reference_record_id = EXCLUDED.promoted_reference_record_id,
           promoted_at = EXCLUDED.promoted_at,
           promotion_profile_key = EXCLUDED.promotion_profile_key,
           promotion_profile_version = EXCLUDED.promotion_profile_version,
           promotion_plan_fingerprint = EXCLUDED.promotion_plan_fingerprint,`
    : "";

  await db.query(
    `INSERT INTO catalog_source_observations (
       observation_id,
       sync_run_id,
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
       promoted_reference_record_id,
       promoted_at,
       promotion_profile_key,
       promotion_profile_version,
       promotion_plan_fingerprint,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
     ON CONFLICT (observation_id) DO UPDATE SET
       sync_run_id = EXCLUDED.sync_run_id,
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
      input.data.syncRunId?.trim() || null,
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
      input.promotedReferenceRecordId,
      input.promotedAt,
      input.data.promotionProfileKey ?? null,
      input.data.promotionProfileVersion ?? null,
      input.data.promotionPlanFingerprint ?? null,
      input.updatedAt,
    ],
  );
}

async function projectObservationScopeChange(
  db: PgQueryable,
  observationId: string,
  updatedAt: string,
  writeObservation: () => Promise<unknown>,
): Promise<void> {
  const previousScopeKey = await readSourceObservationIntegrationScopeKey(db, observationId);
  await writeObservation();
  const nextScopeKey = await readSourceObservationIntegrationScopeKey(db, observationId);
  await rebuildSourceObservationIntegrationScopeSummaries(db, [previousScopeKey, nextScopeKey], updatedAt);
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
