import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import { CATALOG_ALIAS_STREAM_PREFIX } from "../domain/domain";
import type {
  CatalogAliasCandidate,
  CatalogAliasConfidenceKey,
  CatalogAliasProvenance,
  CatalogAliasReviewStateKey,
  CatalogAliasTarget,
  CatalogAliasTypeKey,
} from "../domain/alias";
import {
  enqueueCatalogItemAliasRecomputeWork,
  enqueueReferenceRecordAliasRecomputeWork,
  type AliasRecomputeReason,
} from "./alias-recompute";

// ---------------------------------------------------------------------------
// Catalog Alias projections
//
// Two projection responsibilities:
//   1. Source Observation alias candidates are upserted into
//      `catalog_source_observation_alias_candidates` when an observation is
//      recorded. This is a direct read-model write keyed by alias hash, so a
//      replay or re-import is idempotent. Exposed as a helper so the Source
//      Observation runtime can call it inside the same transaction.
//   2. The Catalog Alias aggregate's lifecycle events project the accepted
//      alias into `catalog_item_aliases` / `catalog_reference_record_aliases`.
//      Acceptance writes the row; rejection/revocation flip review_status in
//      place so provenance and audit history survive (no hard delete).
//
// Because the set of publishable aliases for a target can change with any of
// these events, each handler enqueues bounded, idempotent resolved-alias
// recompute work for the affected target. The recompute worker resolves
// the new publishable set and publishes the `aliases-resolved` fact only when
// the resolved hash changes, including the empty (retracted) fact when the last
// publishable alias is revoked or rejected.
// ---------------------------------------------------------------------------

type CatalogAliasProposedData = {
  aliasHash: string;
  target: CatalogAliasTarget;
  aliasText: string;
  normalizedAliasText: string;
  aliasLanguageCode: string;
  sourceLanguageCode: string | null;
  aliasType: CatalogAliasTypeKey;
  confidence: CatalogAliasConfidenceKey;
  reviewStatus: CatalogAliasReviewStateKey;
  provenance: CatalogAliasProvenance;
  evidence: JsonObject;
  actor: string;
  policyVersion: string;
};

type CatalogAliasReviewData = {
  reviewStatus: CatalogAliasReviewStateKey;
  actor: string;
  reason: string | null;
  policyVersion: string;
};

/**
 * Idempotently upsert Source Observation alias candidates by hash. Safe to call
 * on every observation record/replay: identical evidence overwrites itself,
 * fresh evidence refreshes the row, and `first_observed_at` is preserved.
 */
export async function upsertSourceObservationAliasCandidates(
  db: PgQueryable,
  candidates: readonly CatalogAliasCandidate[],
  observedAt: string,
): Promise<void> {
  for (const candidate of candidates) {
    await db.query(
      `INSERT INTO catalog_source_observation_alias_candidates (
         alias_hash,
         target_kind,
         target_id,
         target_key,
         alias_text,
         normalized_alias_text,
         alias_language_code,
         source_language_code,
         alias_type,
         confidence,
         review_status,
         provider_key,
         observation_id,
         source_category,
         source_profile_key,
         source_profile_version,
         mapping_fingerprint,
         evidence,
         first_observed_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19)
       ON CONFLICT (alias_hash) DO UPDATE SET
         target_id = EXCLUDED.target_id,
         alias_text = EXCLUDED.alias_text,
         source_language_code = EXCLUDED.source_language_code,
         confidence = EXCLUDED.confidence,
         review_status = EXCLUDED.review_status,
         observation_id = EXCLUDED.observation_id,
         source_profile_key = EXCLUDED.source_profile_key,
         source_profile_version = EXCLUDED.source_profile_version,
         mapping_fingerprint = EXCLUDED.mapping_fingerprint,
         evidence = EXCLUDED.evidence,
         updated_at = EXCLUDED.updated_at`,
      [
        candidate.aliasHash,
        candidate.target.kind,
        candidate.target.targetId,
        candidate.target.targetKey,
        candidate.aliasText,
        candidate.normalizedAliasText,
        candidate.aliasLanguageCode,
        candidate.sourceLanguageCode,
        candidate.aliasType,
        candidate.confidence,
        candidate.reviewStatus,
        candidate.provenance.providerKey,
        candidate.provenance.observationId,
        candidate.provenance.sourceCategory,
        candidate.provenance.sourceProfileKey,
        candidate.provenance.sourceProfileVersion,
        candidate.provenance.mappingFingerprint,
        JSON.stringify(candidate.evidence),
        observedAt,
      ],
    );
  }
}

export function buildCatalogAliasProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.alias.proposed": async (event) => {
      const data = event.data as CatalogAliasProposedData;
      const recordedAt = event.timing.recordedAt;
      const reviewedAt = data.reviewStatus === "auto-accepted" ? recordedAt : null;

      if (data.target.kind === "catalog-item") {
        await upsertCatalogItemAlias(db, data, recordedAt, reviewedAt);
      } else {
        await upsertReferenceRecordAlias(db, data, recordedAt, reviewedAt);
      }

      await enqueueAliasRecompute(
        db,
        data.target.kind,
        data.target.targetId,
        "alias-proposed",
        event.streamId,
        recordedAt,
      );
    },
    "catalog.alias.accepted": async (event) => {
      await applyAliasReview(db, event.streamId, event.data as CatalogAliasReviewData, event.timing.recordedAt);
      await enqueueAliasRecomputeForStream(db, event.streamId, "alias-accepted", event.timing.recordedAt);
    },
    "catalog.alias.rejected": async (event) => {
      await applyAliasReview(db, event.streamId, event.data as CatalogAliasReviewData, event.timing.recordedAt);
      await enqueueAliasRecomputeForStream(db, event.streamId, "alias-rejected", event.timing.recordedAt);
    },
    "catalog.alias.revoked": async (event) => {
      await applyAliasReview(db, event.streamId, event.data as CatalogAliasReviewData, event.timing.recordedAt);
      await enqueueAliasRecomputeForStream(db, event.streamId, "alias-revoked", event.timing.recordedAt);
    },
  };
}

/**
 * Enqueue resolved-alias recompute for the target of a known alias kind/id. Used
 * by the proposed handler, which carries the target on the event.
 */
async function enqueueAliasRecompute(
  db: PgQueryable,
  targetKind: CatalogAliasTarget["kind"],
  targetId: string | null,
  reason: AliasRecomputeReason,
  streamId: string,
  recordedAt: string,
): Promise<void> {
  if (!targetId) {
    return;
  }
  const source = { eventType: "catalog.alias.proposed", streamId, recordedAt };
  if (targetKind === "catalog-item") {
    await enqueueCatalogItemAliasRecomputeWork(db, [targetId], reason, source);
  } else {
    await enqueueReferenceRecordAliasRecomputeWork(db, [targetId], reason, source);
  }
}

/**
 * Enqueue recompute for an accept/reject/revoke event, which only carries the
 * alias hash. The persisted alias row routes the hash to its target table and
 * id; the unique hash matches at most one row across both tables.
 */
async function enqueueAliasRecomputeForStream(
  db: PgQueryable,
  streamId: string,
  reason: AliasRecomputeReason,
  recordedAt: string,
): Promise<void> {
  const aliasHash = extractIdFromStreamId(streamId, CATALOG_ALIAS_STREAM_PREFIX);
  const source = { streamId, recordedAt };

  const catalogItem = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM catalog_item_aliases WHERE alias_hash = $1`,
    [aliasHash],
  );
  if (catalogItem.rows[0]?.catalog_item_id) {
    await enqueueCatalogItemAliasRecomputeWork(db, [catalogItem.rows[0].catalog_item_id], reason, source);
    return;
  }

  const referenceRecord = await db.query<{ reference_record_id: string | null }>(
    `SELECT reference_record_id FROM catalog_reference_record_aliases WHERE alias_hash = $1`,
    [aliasHash],
  );
  const referenceRecordId = referenceRecord.rows[0]?.reference_record_id;
  if (referenceRecordId) {
    await enqueueReferenceRecordAliasRecomputeWork(db, [referenceRecordId], reason, source);
  }
}

async function applyAliasReview(
  db: PgQueryable,
  streamId: string,
  data: CatalogAliasReviewData,
  recordedAt: string,
): Promise<void> {
  const aliasHash = extractIdFromStreamId(streamId, CATALOG_ALIAS_STREAM_PREFIX);
  // The alias hash deterministically routes to exactly one table by target
  // kind, but the projection does not know the kind here; updating both is safe
  // because the hash is unique across both tables and only one row matches.
  for (const table of ["catalog_item_aliases", "catalog_reference_record_aliases"] as const) {
    await db.query(
      `UPDATE ${table}
       SET review_status = $2,
           last_actor = $3,
           last_reason = $4,
           policy_version = $5,
           reviewed_at = $6,
           updated_at = $6
       WHERE alias_hash = $1`,
      [aliasHash, data.reviewStatus, data.actor, data.reason, data.policyVersion, recordedAt],
    );
  }
}

async function upsertCatalogItemAlias(
  db: PgQueryable,
  data: CatalogAliasProposedData,
  recordedAt: string,
  reviewedAt: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO catalog_item_aliases (
       alias_hash,
       catalog_item_id,
       target_field,
       alias_text,
       normalized_alias_text,
       alias_language_code,
       source_language_code,
       alias_type,
       confidence,
       review_status,
       provider_key,
       observation_id,
       source_category,
       source_profile_key,
       source_profile_version,
       mapping_fingerprint,
       evidence,
       last_actor,
       last_reason,
       policy_version,
       proposed_at,
       reviewed_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NULL, $19, $20, $21, $20)
     ON CONFLICT (alias_hash) DO UPDATE SET
       catalog_item_id = EXCLUDED.catalog_item_id,
       target_field = EXCLUDED.target_field,
       alias_text = EXCLUDED.alias_text,
       source_language_code = EXCLUDED.source_language_code,
       confidence = EXCLUDED.confidence,
       review_status = EXCLUDED.review_status,
       observation_id = EXCLUDED.observation_id,
       source_profile_key = EXCLUDED.source_profile_key,
       source_profile_version = EXCLUDED.source_profile_version,
       mapping_fingerprint = EXCLUDED.mapping_fingerprint,
       evidence = EXCLUDED.evidence,
       last_actor = EXCLUDED.last_actor,
       policy_version = EXCLUDED.policy_version,
       reviewed_at = EXCLUDED.reviewed_at,
       updated_at = EXCLUDED.updated_at`,
    [
      data.aliasHash,
      requireTargetId(data.target),
      data.target.targetKey,
      data.aliasText,
      data.normalizedAliasText,
      data.aliasLanguageCode,
      data.sourceLanguageCode,
      data.aliasType,
      data.confidence,
      data.reviewStatus,
      data.provenance.providerKey,
      data.provenance.observationId,
      data.provenance.sourceCategory,
      data.provenance.sourceProfileKey,
      data.provenance.sourceProfileVersion,
      data.provenance.mappingFingerprint,
      JSON.stringify(data.evidence),
      data.actor,
      data.policyVersion,
      recordedAt,
      reviewedAt,
    ],
  );
}

async function upsertReferenceRecordAlias(
  db: PgQueryable,
  data: CatalogAliasProposedData,
  recordedAt: string,
  reviewedAt: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO catalog_reference_record_aliases (
       alias_hash,
       reference_record_id,
       type_key,
       alias_text,
       normalized_alias_text,
       alias_language_code,
       source_language_code,
       alias_type,
       confidence,
       review_status,
       provider_key,
       observation_id,
       source_category,
       source_profile_key,
       source_profile_version,
       mapping_fingerprint,
       evidence,
       last_actor,
       last_reason,
       policy_version,
       proposed_at,
       reviewed_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NULL, $19, $20, $21, $20)
     ON CONFLICT (alias_hash) DO UPDATE SET
       reference_record_id = EXCLUDED.reference_record_id,
       type_key = EXCLUDED.type_key,
       alias_text = EXCLUDED.alias_text,
       source_language_code = EXCLUDED.source_language_code,
       confidence = EXCLUDED.confidence,
       review_status = EXCLUDED.review_status,
       observation_id = EXCLUDED.observation_id,
       source_profile_key = EXCLUDED.source_profile_key,
       source_profile_version = EXCLUDED.source_profile_version,
       mapping_fingerprint = EXCLUDED.mapping_fingerprint,
       evidence = EXCLUDED.evidence,
       last_actor = EXCLUDED.last_actor,
       policy_version = EXCLUDED.policy_version,
       reviewed_at = EXCLUDED.reviewed_at,
       updated_at = EXCLUDED.updated_at`,
    [
      data.aliasHash,
      data.target.targetId,
      data.target.targetKey,
      data.aliasText,
      data.normalizedAliasText,
      data.aliasLanguageCode,
      data.sourceLanguageCode,
      data.aliasType,
      data.confidence,
      data.reviewStatus,
      data.provenance.providerKey,
      data.provenance.observationId,
      data.provenance.sourceCategory,
      data.provenance.sourceProfileKey,
      data.provenance.sourceProfileVersion,
      data.provenance.mappingFingerprint,
      JSON.stringify(data.evidence),
      data.actor,
      data.policyVersion,
      recordedAt,
      reviewedAt,
    ],
  );
}

function requireTargetId(target: CatalogAliasTarget): string {
  if (!target.targetId) {
    throw new Error("A Catalog Item alias requires a resolved catalog_item_id before it can be persisted.");
  }
  return target.targetId;
}
