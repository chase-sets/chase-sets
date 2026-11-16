import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import type {
  CatalogAliasConfidenceKey,
  CatalogAliasReviewStateKey,
  CatalogAliasTargetKind,
  CatalogAliasTypeKey,
} from "../../../alias-equivalence/domain/alias";
import type { CatalogAliasSourceCategoryKey } from "../governance/catalog-integration-data-governance";
import {
  listCatalogItemAliases,
  listReferenceRecordAliases,
  type CatalogAliasCandidateRow,
  type CatalogItemAliasRow,
  type CatalogReferenceRecordAliasRow,
} from "../../../alias-equivalence/read-model/queries";
import type { PromotionAliasCandidate, PromotionPublishedAlias } from "./provider-promotion-alias-planner";
import type { PromotionAliasReader } from "./provider-promotion-alias-writer";

// ---------------------------------------------------------------------------
// Promotion alias reader adapter
//
// Default `PromotionAliasReader` over the alias read-model. Promotion
// reads only the reviewed candidates an observation produced and only the
// already-published (accepted/auto-accepted) aliases for the resolved targets,
// so the writer can decide what to publish and what to retract. The composition
// root injects this; tests can inject an in-memory reader instead.
// ---------------------------------------------------------------------------

export function createPromotionAliasReader(db: PgQueryable): PromotionAliasReader {
  return {
    listCandidatesForObservation: async (observationId) => {
      // Intake supplies evidence and policy intent, not the aggregate's review
      // decision. Pending evidence must also reach promotion to resolve identity.
      const result = await db.query<CatalogAliasCandidateRow & { promotion_review_status: CatalogAliasReviewStateKey }>(
        `SELECT candidate.*,
           CASE WHEN COALESCE(item.alias_hash, reference.alias_hash) IS NULL THEN candidate.review_status
             WHEN candidate.evidence = COALESCE(item.evidence, reference.evidence)
               AND candidate.confidence = COALESCE(item.confidence, reference.confidence)
               AND candidate.source_language_code IS NOT DISTINCT FROM COALESCE(item.source_language_code, reference.source_language_code)
             THEN COALESCE(item.review_status, reference.review_status)
             ELSE 'pending' END AS promotion_review_status
         FROM catalog_source_observation_alias_candidates candidate
         LEFT JOIN catalog_item_aliases item ON item.alias_hash = candidate.alias_hash
         LEFT JOIN catalog_reference_record_aliases reference ON reference.alias_hash = candidate.alias_hash
         WHERE candidate.observation_id = $1 ORDER BY candidate.first_observed_at DESC, candidate.alias_hash ASC LIMIT 1000`,
        [observationId],
      );
      return result.rows.map((row) =>
        toPromotionAliasCandidate({ ...row, review_status: row.promotion_review_status }),
      );
    },
    listPublishedCatalogItemAliases: async (catalogItemId) => {
      const rows = await listCatalogItemAliases(db, catalogItemId, {
        reviewStatuses: ["accepted", "auto-accepted"],
      });
      return rows.map(catalogItemAliasToPublished);
    },
    listPublishedReferenceRecordAliases: async (referenceRecordId) => {
      const rows = await listReferenceRecordAliases(db, referenceRecordId, {
        reviewStatuses: ["accepted", "auto-accepted"],
      });
      return rows.map(referenceRecordAliasToPublished);
    },
  };
}

function toPromotionAliasCandidate(row: CatalogAliasCandidateRow): PromotionAliasCandidate {
  return {
    target: {
      kind: row.target_kind as CatalogAliasTargetKind,
      targetKey: row.target_key,
    },
    aliasText: row.alias_text,
    aliasLanguageCode: row.alias_language_code,
    sourceLanguageCode: row.source_language_code,
    aliasType: row.alias_type as CatalogAliasTypeKey,
    confidence: row.confidence as CatalogAliasConfidenceKey,
    reviewStatus: row.review_status,
    provenance: {
      providerKey: row.provider_key,
      observationId: row.observation_id,
      sourceCategory: row.source_category as CatalogAliasSourceCategoryKey,
      sourceProfileKey: row.source_profile_key,
      sourceProfileVersion: row.source_profile_version,
      mappingFingerprint: row.mapping_fingerprint,
    },
    evidence: (row.evidence ?? {}) as JsonObject,
  };
}

function catalogItemAliasToPublished(row: CatalogItemAliasRow): PromotionPublishedAlias {
  return {
    aliasHash: row.alias_hash,
    reviewStatus: row.review_status,
    observationId: row.observation_id,
    providerKey: row.provider_key,
  };
}

function referenceRecordAliasToPublished(row: CatalogReferenceRecordAliasRow): PromotionPublishedAlias {
  return {
    aliasHash: row.alias_hash,
    reviewStatus: row.review_status,
    observationId: row.observation_id,
    providerKey: row.provider_key,
  };
}
