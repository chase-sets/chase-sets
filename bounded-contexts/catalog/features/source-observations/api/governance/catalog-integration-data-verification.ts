import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { escapeLikePattern } from "@chase-sets/event-core-postgres";

export type CatalogIntegrationDataVerificationReport = Readonly<{
  providerProfileVersions: number;
  adminAuthoredProfileVersions: number;
  referencedProfileVersions: number;
  activeProviderProfiles: number;
  sourceObservations: number;
  sourceObservationEventStreams: number;
  sourceObservationEvents: number;
  legacySourceObservationReferences: number;
  integrationDurableJobs: number;
  activeIntegrationDurableJobs: number;
  integrationWorkUnits: number;
  bulkReviewJobs: number;
  activeBulkReviewJobs: number;
  bulkReviewWorkUnits: number;
  profileSections: number;
  profileSectionDiagnostics: number;
  providerOptionQueryCacheEntries: number;
  providerOptionRateLimits: number;
  providerOptionRateLimitsAboveFloor: number;
}>;

type CountRow = Readonly<{ count: number | string }>;

const CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_PREFIX = "catalog.source-observation-";

function sourceObservationStreamLikePattern(): string {
  return `${escapeLikePattern(CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_PREFIX)}%`;
}

export async function collectCatalogIntegrationDataVerificationReport(
  db: PgQueryable,
): Promise<CatalogIntegrationDataVerificationReport> {
  const providerProfileVersions = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_provider_integration_profile_versions",
  );
  const adminAuthoredProfileVersions = await countRows(
    db,
    `SELECT COUNT(*) AS count
       FROM catalog_provider_integration_profile_versions
       WHERE authoring_audit_json IS NOT NULL
          OR migration_evidence_json IS NOT NULL`,
  );
  const referencedProfileVersions = await countRows(
    db,
    `WITH referenced_versions AS (
         SELECT provider_key, source_profile_version AS profile_version
         FROM catalog_source_observations
         UNION
         SELECT provider_key, promotion_profile_version AS profile_version
         FROM catalog_source_observations
         WHERE promotion_profile_version IS NOT NULL
       )
       SELECT COUNT(*) AS count
       FROM referenced_versions
       WHERE profile_version IS NOT NULL
         AND profile_version <> 'legacy'`,
  );
  const activeProviderProfiles = await countRows(
    db,
    `SELECT COUNT(*) AS count
       FROM catalog_provider_integration_profile_versions
       WHERE active = true AND lifecycle = 'active'`,
  );
  const sourceObservations = await countRows(db, "SELECT COUNT(*) AS count FROM catalog_source_observations");
  const sourceObservationEventStreams = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM event_store_streams WHERE stream_id LIKE $1 ESCAPE '\\'",
    [sourceObservationStreamLikePattern()],
  );
  const sourceObservationEvents = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1 ESCAPE '\\'",
    [sourceObservationStreamLikePattern()],
  );
  const legacySourceObservationReferences = await countRows(
    db,
    `SELECT COUNT(*) AS count
       FROM catalog_source_observations
       WHERE source_profile_version = 'legacy'
          OR source_mapping_fingerprint = 'legacy'
          OR promotion_profile_version = 'legacy'`,
  );
  const integrationDurableJobs = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_source_observation_integration_durable_jobs",
  );
  const activeIntegrationDurableJobs = await countRows(
    db,
    `SELECT COUNT(*) AS count
       FROM catalog_source_observation_integration_durable_jobs
       WHERE status IN ('queued', 'running')`,
  );
  const integrationWorkUnits = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_source_observation_integration_work_units",
  );
  const bulkReviewJobs = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_source_observation_bulk_review_jobs",
  );
  const activeBulkReviewJobs = await countRows(
    db,
    `SELECT COUNT(*) AS count
       FROM catalog_source_observation_bulk_review_jobs
       WHERE status IN ('queued', 'running')`,
  );
  const bulkReviewWorkUnits = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_source_observation_bulk_review_work_units",
  );
  const profileSections = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_provider_profile_version_sections",
  );
  const profileSectionDiagnostics = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_provider_profile_version_section_diagnostics",
  );
  const providerOptionRateLimits = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_tcgplayer_automation_domain_rate_limits",
  );
  const providerOptionRateLimitsAboveFloor = await countRows(
    db,
    `SELECT COUNT(*) AS count
       FROM catalog_tcgplayer_automation_domain_rate_limits
      WHERE effective_request_delay_ms <> min_request_delay_ms
         OR effective_learned_min_delay_ms <> min_request_delay_ms
         OR shared_success_streak <> 0`,
  );
  const providerOptionQueryCacheEntries = await countRows(
    db,
    "SELECT COUNT(*) AS count FROM catalog_provider_option_query_cache",
  );

  return {
    providerProfileVersions,
    adminAuthoredProfileVersions,
    referencedProfileVersions,
    activeProviderProfiles,
    sourceObservations,
    sourceObservationEventStreams,
    sourceObservationEvents,
    legacySourceObservationReferences,
    integrationDurableJobs,
    activeIntegrationDurableJobs,
    integrationWorkUnits,
    bulkReviewJobs,
    activeBulkReviewJobs,
    bulkReviewWorkUnits,
    profileSections,
    profileSectionDiagnostics,
    providerOptionQueryCacheEntries,
    providerOptionRateLimits,
    providerOptionRateLimitsAboveFloor,
  };
}

export function catalogIntegrationDataRollbackChecklist(): readonly string[] {
  return [
    "Stop or cancel queued/running Catalog integration and bulk review jobs before rollback.",
    "Activate the prior validated Provider Integration Profile version instead of editing historical profile rows.",
    "Let already queued integration jobs finish against their snapshotted profile version, or cancel and re-enqueue them.",
    "Run a narrow import or reapply after rollback and compare Source Observation counts, diagnostics, and promotion plans.",
    "Rebuild profile section projections from the retained/active profile version and verify no legacy profile references remain.",
  ];
}

export function catalogIntegrationDataReleaseVerificationQueries(): readonly string[] {
  return [
    "SELECT COUNT(*) AS provider_profile_versions FROM catalog_provider_integration_profile_versions;",
    "SELECT COUNT(*) AS active_provider_profiles FROM catalog_provider_integration_profile_versions WHERE active = true AND lifecycle = 'active';",
    "SELECT COUNT(*) AS source_observations FROM catalog_source_observations;",
    `SELECT COUNT(*) AS source_observation_event_streams FROM event_store_streams WHERE stream_id LIKE '${CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_PREFIX}%' ESCAPE '\\';`,
    `SELECT COUNT(*) AS source_observation_events FROM event_store_events WHERE stream_id LIKE '${CATALOG_SOURCE_OBSERVATION_EVENT_STREAM_PREFIX}%' ESCAPE '\\';`,
    "SELECT COUNT(*) AS legacy_source_observation_references FROM catalog_source_observations WHERE source_profile_version = 'legacy' OR source_mapping_fingerprint = 'legacy' OR promotion_profile_version = 'legacy';",
    "SELECT status, COUNT(*) AS jobs FROM catalog_source_observation_integration_durable_jobs GROUP BY status ORDER BY status;",
    "SELECT state, COUNT(*) AS work_units FROM catalog_source_observation_integration_work_units GROUP BY state ORDER BY state;",
    "SELECT COUNT(*) AS profile_sections FROM catalog_provider_profile_version_sections;",
    "SELECT COUNT(*) AS profile_section_diagnostics FROM catalog_provider_profile_version_section_diagnostics;",
  ];
}

async function countRows(db: PgQueryable, sql: string, params: readonly unknown[] = []): Promise<number> {
  const result = await db.query<CountRow>(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}
