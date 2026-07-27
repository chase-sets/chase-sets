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
  listSourceObservationAliasCandidates,
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

/** Review statuses promotion cares about: accept signals to publish, reject/revoke signals to retract. */
const PROMOTION_RELEVANT_CANDIDATE_STATUSES: readonly CatalogAliasReviewStateKey[] = [
  "accepted",
  "auto-accepted",
  "rejected",
  "revoked",
];

export function createPromotionAliasReader(db: PgQueryable): PromotionAliasReader {
  return {
    listCandidatesForObservation: async (observationId) => {
      const rows = await listSourceObservationAliasCandidates(db, {
        observationId,
        reviewStatuses: PROMOTION_RELEVANT_CANDIDATE_STATUSES,
        // The candidate table is keyed by hash; the per-observation slice is
        // small, but cap defensively so a pathological observation cannot
        // unbound the promotion turn.
        limit: 1000,
      });
      return rows.map(toPromotionAliasCandidate);
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
