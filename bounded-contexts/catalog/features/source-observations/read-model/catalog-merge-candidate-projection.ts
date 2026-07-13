import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  CatalogMergeCandidateObservationMember,
  CatalogMergeCandidateReviewSnapshot,
  CatalogMergeCandidateStatus,
} from "../domain/catalog-merge-candidate";

const CATALOG_MERGE_CANDIDATE_STREAM_PREFIX = "catalog.merge-candidate-";

type CandidateSnapshotEventData = {
  candidateId?: string;
  status: Extract<CatalogMergeCandidateStatus, "ready" | "has-conflicts">;
  snapshot: CatalogMergeCandidateReviewSnapshot;
  createdAt?: string;
  refreshedAt?: string;
};

type CandidateActionAuditData = {
  reason: string;
};

export function buildCatalogMergeCandidateProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.merge-candidate.created": async (event) => {
      const data = event.data as CandidateSnapshotEventData;
      const candidateId = candidateIdFromEvent(data, event.streamId);
      await upsertCandidate(db, {
        candidateId,
        status: data.status,
        statusReason: null,
        snapshot: data.snapshot,
        createdAt: data.createdAt ?? event.timing.recordedAt,
        updatedAt: event.timing.recordedAt,
        staleAt: null,
      });
      await replaceCandidateMembership(db, candidateId, data.snapshot.membership);
    },
    "catalog.merge-candidate.refreshed": async (event) => {
      const data = event.data as CandidateSnapshotEventData;
      const candidateId = candidateIdFromEvent(data, event.streamId);
      await upsertCandidate(db, {
        candidateId,
        status: data.status,
        statusReason: null,
        snapshot: data.snapshot,
        createdAt: null,
        updatedAt: event.timing.recordedAt,
        staleAt: null,
      });
      await replaceCandidateMembership(db, candidateId, data.snapshot.membership);
    },
    "catalog.merge-candidate.marked-stale": async (event) => {
      const data = event.data as {
        candidateId?: string;
        reason: string;
        staleAt: string;
        triggeredByObservationIds: readonly string[];
      };
      const candidateId = candidateIdFromEvent(data, event.streamId);

      await db.query(
        `UPDATE catalog_merge_candidates
         SET status = 'stale',
             status_reason = $2,
             stale_at = $3,
             updated_at = $4
         WHERE candidate_id = $1`,
        [candidateId, data.reason, data.staleAt, event.timing.recordedAt],
      );
    },
    "catalog.merge-candidate.observation-added": async (event) => {
      const data = event.data as {
        candidateId?: string;
        member: CatalogMergeCandidateObservationMember;
        updatedAt: string;
      };
      const candidateId = candidateIdFromEvent(data, event.streamId);

      await upsertCandidateMember(db, candidateId, data.member);
      await markCandidateMembershipChanged(db, {
        candidateId,
        reason: "Source Observation membership changed; refresh candidate before review.",
        staleAt: data.updatedAt,
        updatedAt: event.timing.recordedAt,
      });
    },
    "catalog.merge-candidate.observation-removed": async (event) => {
      const data = event.data as {
        candidateId?: string;
        observationId: string;
        reason: string;
        removedAt: string;
      };
      const candidateId = candidateIdFromEvent(data, event.streamId);

      await db.query(
        `DELETE FROM catalog_merge_candidate_observations
         WHERE candidate_id = $1
           AND observation_id = $2`,
        [candidateId, data.observationId],
      );
      await markCandidateMembershipChanged(db, {
        candidateId,
        reason: `Source Observation membership changed: ${data.reason}`,
        staleAt: data.removedAt,
        updatedAt: event.timing.recordedAt,
      });
    },
    "catalog.merge-candidate.promoted": async (event) => {
      const data = event.data as {
        candidateId?: string;
        audit: CandidateActionAuditData;
        promotedAt: string;
      };
      const candidateId = candidateIdFromEvent(data, event.streamId);

      await updateCandidateReviewStatus(db, {
        candidateId,
        status: "promoted",
        reason: `Candidate accepted for Catalog promotion planning: ${data.audit.reason}`,
        actionAt: data.promotedAt,
        updatedAt: event.timing.recordedAt,
      });
    },
    "catalog.merge-candidate.split": async (event) => {
      const data = event.data as {
        candidateId?: string;
        status: Extract<CatalogMergeCandidateStatus, "ready" | "has-conflicts">;
        remainingSnapshot: CatalogMergeCandidateReviewSnapshot;
        splitCandidateId: string;
        splitSnapshot: CatalogMergeCandidateReviewSnapshot;
        audit: CandidateActionAuditData;
        splitAt: string;
      };
      const candidateId = candidateIdFromEvent(data, event.streamId);

      await upsertCandidate(db, {
        candidateId,
        status: data.status,
        statusReason: `Candidate split: ${data.audit.reason}`,
        snapshot: data.remainingSnapshot,
        createdAt: null,
        updatedAt: event.timing.recordedAt,
        staleAt: null,
      });
      await replaceCandidateMembership(db, candidateId, data.remainingSnapshot.membership);
      await upsertCandidate(db, {
        candidateId: data.splitCandidateId,
        status: data.splitSnapshot.conflicts.some((conflict) => conflict.severity === "blocking")
          ? "has-conflicts"
          : "ready",
        statusReason: `Candidate split from ${candidateId}: ${data.audit.reason}`,
        snapshot: data.splitSnapshot,
        createdAt: data.splitAt,
        updatedAt: event.timing.recordedAt,
        staleAt: null,
      });
      await replaceCandidateMembership(db, data.splitCandidateId, data.splitSnapshot.membership);
    },
    "catalog.merge-candidate.updated": async (event) => {
      const data = event.data as {
        candidateId?: string;
        status: Extract<CatalogMergeCandidateStatus, "ready" | "has-conflicts">;
        snapshot: CatalogMergeCandidateReviewSnapshot;
        audit: CandidateActionAuditData;
        updatedAt: string;
      };
      const candidateId = candidateIdFromEvent(data, event.streamId);

      await upsertCandidate(db, {
        candidateId,
        status: data.status,
        statusReason: `Candidate updated: ${data.audit.reason}`,
        snapshot: data.snapshot,
        createdAt: null,
        updatedAt: event.timing.recordedAt,
        staleAt: null,
      });
      await replaceCandidateMembership(db, candidateId, data.snapshot.membership);
    },
    "catalog.merge-candidate.ignored": async (event) => {
      const data = event.data as {
        candidateId?: string;
        audit: CandidateActionAuditData;
        ignoredAt: string;
      };
      const candidateId = candidateIdFromEvent(data, event.streamId);

      await updateCandidateReviewStatus(db, {
        candidateId,
        status: "rejected",
        reason: `Candidate ignored: ${data.audit.reason}`,
        actionAt: data.ignoredAt,
        updatedAt: event.timing.recordedAt,
      });
    },
    "catalog.merge-candidate.deferred": async (event) => {
      const data = event.data as {
        candidateId?: string;
        audit: CandidateActionAuditData;
        deferredAt: string;
      };
      const candidateId = candidateIdFromEvent(data, event.streamId);

      await updateCandidateReviewStatus(db, {
        candidateId,
        status: "deferred",
        reason: data.audit.reason,
        actionAt: data.deferredAt,
        updatedAt: event.timing.recordedAt,
      });
    },
  };
}

async function upsertCandidate(
  db: PgQueryable,
  input: Readonly<{
    candidateId: string;
    status: CatalogMergeCandidateStatus;
    statusReason: string | null;
    snapshot: CatalogMergeCandidateReviewSnapshot;
    createdAt: string | null;
    updatedAt: string;
    staleAt: string | null;
  }>,
): Promise<void> {
  await db.query(
    `INSERT INTO catalog_merge_candidates (
       candidate_id,
       scope_record_id,
       identity_fingerprint,
       sync_run_ids_json,
       status,
       status_reason,
       identity_json,
       matched_catalog_item_id,
       matched_product_ids_json,
       proposed_catalog_item_facts_json,
       proposed_external_catalog_item_references_json,
       proposed_external_product_references_json,
       conflicts_json,
       warnings_json,
       field_provenance_json,
       promotion_intent,
       created_at,
       updated_at,
       stale_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, COALESCE($17::timestamptz, now()), $18, $19)
     ON CONFLICT (candidate_id) DO UPDATE SET
       scope_record_id = EXCLUDED.scope_record_id,
       identity_fingerprint = EXCLUDED.identity_fingerprint,
       sync_run_ids_json = EXCLUDED.sync_run_ids_json,
       status = EXCLUDED.status,
       status_reason = EXCLUDED.status_reason,
       identity_json = EXCLUDED.identity_json,
       matched_catalog_item_id = EXCLUDED.matched_catalog_item_id,
       matched_product_ids_json = EXCLUDED.matched_product_ids_json,
       proposed_catalog_item_facts_json = EXCLUDED.proposed_catalog_item_facts_json,
       proposed_external_catalog_item_references_json = EXCLUDED.proposed_external_catalog_item_references_json,
       proposed_external_product_references_json = EXCLUDED.proposed_external_product_references_json,
       conflicts_json = EXCLUDED.conflicts_json,
       warnings_json = EXCLUDED.warnings_json,
       field_provenance_json = EXCLUDED.field_provenance_json,
       promotion_intent = EXCLUDED.promotion_intent,
       updated_at = EXCLUDED.updated_at,
       stale_at = EXCLUDED.stale_at`,
    [
      input.candidateId,
      input.snapshot.identity.scopeRecordId,
      input.snapshot.identityFingerprint,
      JSON.stringify(input.snapshot.syncRunIds),
      input.status,
      input.statusReason,
      JSON.stringify(input.snapshot.identity),
      input.snapshot.matches.catalogItemId,
      JSON.stringify(input.snapshot.matches.productIds),
      JSON.stringify(input.snapshot.proposedCatalogItemFacts),
      JSON.stringify(input.snapshot.proposedExternalCatalogItemReferences),
      JSON.stringify(input.snapshot.proposedExternalProductReferences),
      JSON.stringify(input.snapshot.conflicts),
      JSON.stringify(input.snapshot.warnings),
      JSON.stringify(input.snapshot.fieldProvenance),
      input.snapshot.promotionIntent,
      input.createdAt,
      input.updatedAt,
      input.staleAt,
    ],
  );
}

async function replaceCandidateMembership(
  db: PgQueryable,
  candidateId: string,
  membership: readonly CatalogMergeCandidateObservationMember[],
): Promise<void> {
  await db.query(`DELETE FROM catalog_merge_candidate_observations WHERE candidate_id = $1`, [candidateId]);
  for (const member of membership) {
    await upsertCandidateMember(db, candidateId, member);
  }
}

async function upsertCandidateMember(
  db: PgQueryable,
  candidateId: string,
  member: CatalogMergeCandidateObservationMember,
): Promise<void> {
  await db.query(
    `INSERT INTO catalog_merge_candidate_observations (
       candidate_id,
       observation_id,
       sync_run_id,
       provider_key,
       external_key,
       source_record_hash,
       source_profile_key,
       source_profile_version,
       source_mapping_fingerprint,
       observed_at,
       added_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (candidate_id, observation_id) DO UPDATE SET
       sync_run_id = EXCLUDED.sync_run_id,
       provider_key = EXCLUDED.provider_key,
       external_key = EXCLUDED.external_key,
       source_record_hash = EXCLUDED.source_record_hash,
       source_profile_key = EXCLUDED.source_profile_key,
       source_profile_version = EXCLUDED.source_profile_version,
       source_mapping_fingerprint = EXCLUDED.source_mapping_fingerprint,
       observed_at = EXCLUDED.observed_at,
       added_at = EXCLUDED.added_at`,
    [
      candidateId,
      member.observationId,
      member.syncRunId,
      member.providerKey,
      member.externalKey,
      member.sourceRecordHash,
      member.sourceProfileKey,
      member.sourceProfileVersion,
      member.sourceMappingFingerprint,
      member.observedAt,
      member.addedAt,
    ],
  );
}

function candidateIdFromEvent(data: { candidateId?: string }, streamId: string): string {
  return data.candidateId ?? extractIdFromStreamId(streamId, CATALOG_MERGE_CANDIDATE_STREAM_PREFIX);
}

async function markCandidateMembershipChanged(
  db: PgQueryable,
  input: Readonly<{
    candidateId: string;
    reason: string;
    staleAt: string;
    updatedAt: string;
  }>,
): Promise<void> {
  await db.query(
    `UPDATE catalog_merge_candidates
     SET status = 'stale',
         status_reason = $2,
         stale_at = $3,
         updated_at = $4
     WHERE candidate_id = $1`,
    [input.candidateId, input.reason, input.staleAt, input.updatedAt],
  );
}

async function updateCandidateReviewStatus(
  db: PgQueryable,
  input: Readonly<{
    candidateId: string;
    status: Extract<CatalogMergeCandidateStatus, "promoted" | "rejected" | "deferred">;
    reason: string;
    actionAt: string;
    updatedAt: string;
  }>,
): Promise<void> {
  await db.query(
    `UPDATE catalog_merge_candidates
     SET status = $2,
         status_reason = $3,
         stale_at = NULL,
         updated_at = $4
     WHERE candidate_id = $1`,
    [input.candidateId, input.status, input.reason, input.updatedAt],
  );
}
