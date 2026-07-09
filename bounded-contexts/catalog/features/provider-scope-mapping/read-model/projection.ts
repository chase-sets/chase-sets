import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import { CATALOG_PROVIDER_SCOPE_MAPPING_STREAM_PREFIX } from "../domain/domain";
import type {
  ProviderScopeMappingConfidenceTier,
  ProviderScopeMappingCoordinates,
  ProviderScopeMappingProvenance,
  ProviderScopeMappingReviewStatus,
} from "../domain/mapping";

type ProviderScopeMappingProposedData = {
  mappingId: string;
  scopeRecordId: string;
  providerKey: string;
  unitKey: string;
  coordinates: ProviderScopeMappingCoordinates;
  confidence: ProviderScopeMappingConfidenceTier;
  reviewStatus: ProviderScopeMappingReviewStatus;
  provenance: ProviderScopeMappingProvenance;
  evidence: JsonObject;
  actor: string;
  policyVersion: string;
};

type ProviderScopeMappingReviewData = {
  reviewStatus: ProviderScopeMappingReviewStatus;
  actor: string;
  reason: string | null;
  policyVersion: string;
};

export function buildProviderScopeMappingProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.provider-scope-mapping.proposed": async (event) => {
      await upsertProviderScopeMapping(db, event.data as ProviderScopeMappingProposedData, event.timing.recordedAt);
    },
    "catalog.provider-scope-mapping.accepted": async (event) => {
      await applyProviderScopeMappingReview(
        db,
        event.streamId,
        event.data as ProviderScopeMappingReviewData,
        event.timing.recordedAt,
      );
    },
    "catalog.provider-scope-mapping.rejected": async (event) => {
      await applyProviderScopeMappingReview(
        db,
        event.streamId,
        event.data as ProviderScopeMappingReviewData,
        event.timing.recordedAt,
      );
    },
    "catalog.provider-scope-mapping.revoked": async (event) => {
      await applyProviderScopeMappingReview(
        db,
        event.streamId,
        event.data as ProviderScopeMappingReviewData,
        event.timing.recordedAt,
      );
    },
  };
}

async function upsertProviderScopeMapping(
  db: PgQueryable,
  data: ProviderScopeMappingProposedData,
  recordedAt: string,
): Promise<void> {
  const reviewedAt = data.reviewStatus === "auto-accepted" ? recordedAt : null;
  await db.query(
    `INSERT INTO catalog_provider_scope_mappings (
       mapping_id,
       scope_record_id,
       provider_key,
       unit_key,
       product_line_id,
       series_id,
       set_id,
       set_name,
       language_coordinates,
       confidence,
       review_status,
       provenance,
       evidence,
       last_actor,
       last_reason,
       policy_version,
       proposed_at,
       reviewed_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL, $15, $16, $17, $16)
     ON CONFLICT (mapping_id) DO UPDATE SET
       scope_record_id = EXCLUDED.scope_record_id,
       provider_key = EXCLUDED.provider_key,
       unit_key = EXCLUDED.unit_key,
       product_line_id = EXCLUDED.product_line_id,
       series_id = EXCLUDED.series_id,
       set_id = EXCLUDED.set_id,
       set_name = EXCLUDED.set_name,
       language_coordinates = EXCLUDED.language_coordinates,
       confidence = EXCLUDED.confidence,
       review_status = EXCLUDED.review_status,
       provenance = EXCLUDED.provenance,
       evidence = EXCLUDED.evidence,
       last_actor = EXCLUDED.last_actor,
       last_reason = EXCLUDED.last_reason,
       policy_version = EXCLUDED.policy_version,
       reviewed_at = EXCLUDED.reviewed_at,
       updated_at = EXCLUDED.updated_at`,
    [
      data.mappingId,
      data.scopeRecordId,
      data.providerKey,
      data.unitKey,
      data.coordinates.productLineId,
      data.coordinates.seriesId,
      data.coordinates.setId,
      data.coordinates.setName,
      JSON.stringify(data.coordinates.language),
      data.confidence,
      data.reviewStatus,
      JSON.stringify(data.provenance),
      JSON.stringify(data.evidence),
      data.actor,
      data.policyVersion,
      recordedAt,
      reviewedAt,
    ],
  );
}

async function applyProviderScopeMappingReview(
  db: PgQueryable,
  streamId: string,
  data: ProviderScopeMappingReviewData,
  recordedAt: string,
): Promise<void> {
  const mappingId = extractIdFromStreamId(streamId, CATALOG_PROVIDER_SCOPE_MAPPING_STREAM_PREFIX);
  await db.query(
    `UPDATE catalog_provider_scope_mappings
     SET review_status = $2,
         last_actor = $3,
         last_reason = $4,
         policy_version = $5,
         reviewed_at = $6,
         updated_at = $6
     WHERE mapping_id = $1`,
    [mappingId, data.reviewStatus, data.actor, data.reason, data.policyVersion, recordedAt],
  );
}
