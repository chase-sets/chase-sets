import { type PgQueryable, type PgTransactionalPool, withPgTransaction } from "@chase-sets/event-core-postgres";
import {
  activateCatalogProviderIntegrationProfileVersion,
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfile,
  type CatalogProviderIntegrationProfileAuthoringAudit,
  type CatalogProviderIntegrationProfileMigrationEvidence,
  type CatalogProviderIntegrationProfileRetirementPlan,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderMappingSourceContract,
  CatalogProviderProfileFixtureContract,
  CatalogProviderProfileLifecycle,
} from "./provider-integration-mapping-contract";
import { refreshCatalogProviderProfileVersionSectionProjections } from "./provider-profile-section-projection";

type CatalogProviderIntegrationProfileVersionRow = Readonly<{
  provider_key: string;
  profile_key: string;
  profile_version: string;
  lifecycle: CatalogProviderProfileLifecycle;
  active: boolean;
  profile_json: CatalogProviderIntegrationProfile | string;
  source_contract_json: CatalogProviderMappingSourceContract | string;
  fixture_contract_json: CatalogProviderProfileFixtureContract | string;
  retirement_plan_json: CatalogProviderIntegrationProfileRetirementPlan | string | null;
  executable_mapping_contract_json: CatalogProviderExecutableMappingContract | string | null;
  migration_evidence_json: CatalogProviderIntegrationProfileMigrationEvidence | string | null;
  authoring_audit_json: CatalogProviderIntegrationProfileAuthoringAudit | string | null;
}>;

export type CatalogProviderIntegrationProfileVersionStore = Readonly<{
  seedProfileVersions: (
    versions?: readonly CatalogProviderIntegrationProfileVersionRecord[],
  ) => Promise<readonly CatalogProviderIntegrationProfileVersionRecord[]>;
  upsertProfileVersion: (
    version: CatalogProviderIntegrationProfileVersionRecord,
  ) => Promise<CatalogProviderIntegrationProfileVersionRecord>;
  listProfileVersions: (
    providerKey?: string | null,
  ) => Promise<readonly CatalogProviderIntegrationProfileVersionRecord[]>;
  getProfileVersion: (
    providerKey: string,
    profileVersion: string,
  ) => Promise<CatalogProviderIntegrationProfileVersionRecord | null>;
  getActiveProfileVersion: (providerKey: string) => Promise<CatalogProviderIntegrationProfileVersionRecord | null>;
  activateProfileVersion: (
    providerKey: string,
    profileVersion: string,
  ) => Promise<CatalogProviderIntegrationProfileVersionRecord>;
  deprecateProfileVersion: (
    providerKey: string,
    profileVersion: string,
  ) => Promise<CatalogProviderIntegrationProfileVersionRecord>;
  rollbackProfileVersion: (
    providerKey: string,
    rollbackToProfileVersion: string,
  ) => Promise<CatalogProviderIntegrationProfileVersionRecord>;
  countProfileVersionReferences: (providerKey: string, profileVersion: string) => Promise<number>;
}>;

export function createCatalogProviderIntegrationProfileVersionStore(
  db: PgQueryable,
): CatalogProviderIntegrationProfileVersionStore {
  return {
    seedProfileVersions: async (versions = catalogProviderIntegrationProfileVersions) => {
      const seeded: CatalogProviderIntegrationProfileVersionRecord[] = [];
      for (const version of versions) {
        const existing = await getProfileVersion(db, version.providerKey, version.profileVersion);
        if (isAdminAuthoredProfileVersion(existing)) {
          seeded.push(existing);
          continue;
        }
        seeded.push(await upsertProfileVersion(db, version));
      }
      await assertSeededActiveProfileVersions(db, versions);
      return seeded;
    },
    upsertProfileVersion: (version) => upsertProfileVersion(db, version),
    listProfileVersions: (providerKey) => listProfileVersions(db, providerKey),
    getProfileVersion: (providerKey, profileVersion) => getProfileVersion(db, providerKey, profileVersion),
    getActiveProfileVersion: (providerKey) => getActiveProfileVersion(db, providerKey),
    activateProfileVersion: (providerKey, profileVersion) => activateProfileVersion(db, providerKey, profileVersion),
    deprecateProfileVersion: (providerKey, profileVersion) => deprecateProfileVersion(db, providerKey, profileVersion),
    rollbackProfileVersion: (providerKey, rollbackToProfileVersion) =>
      activateProfileVersion(db, providerKey, rollbackToProfileVersion),
    countProfileVersionReferences: (providerKey, profileVersion) =>
      countProfileVersionReferences(db, providerKey, profileVersion),
  };
}

function isAdminAuthoredProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord | null,
): version is CatalogProviderIntegrationProfileVersionRecord {
  return Boolean(version?.authoringAudit || version?.migrationEvidence);
}

export async function seedCatalogProviderIntegrationProfileVersions(
  db: PgQueryable,
): Promise<readonly CatalogProviderIntegrationProfileVersionRecord[]> {
  return createCatalogProviderIntegrationProfileVersionStore(db).seedProfileVersions();
}

async function upsertProfileVersion(
  db: PgQueryable,
  version: CatalogProviderIntegrationProfileVersionRecord,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  return withOptionalProfileVersionTransaction(db, (queryable) => upsertProfileVersionSnapshot(queryable, version));
}

async function upsertProfileVersionSnapshot(
  db: PgQueryable,
  version: CatalogProviderIntegrationProfileVersionRecord,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  if (version.active && version.lifecycle === "active") {
    await deactivateOtherActiveProfileVersions(db, version);
  }

  const result = await db.query<CatalogProviderIntegrationProfileVersionRow>(
    `INSERT INTO catalog_provider_integration_profile_versions (
       provider_key,
       profile_key,
       profile_version,
       lifecycle,
       active,
       profile_json,
       source_contract_json,
       fixture_contract_json,
       retirement_plan_json,
       executable_mapping_contract_json,
       migration_evidence_json,
       authoring_audit_json
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)
     ON CONFLICT (provider_key, profile_key, profile_version) DO UPDATE SET
       lifecycle = EXCLUDED.lifecycle,
       active = EXCLUDED.active,
       profile_json = EXCLUDED.profile_json,
       source_contract_json = EXCLUDED.source_contract_json,
       fixture_contract_json = EXCLUDED.fixture_contract_json,
       retirement_plan_json = EXCLUDED.retirement_plan_json,
       executable_mapping_contract_json = EXCLUDED.executable_mapping_contract_json,
       migration_evidence_json = EXCLUDED.migration_evidence_json,
       authoring_audit_json = EXCLUDED.authoring_audit_json,
       activated_at = CASE WHEN EXCLUDED.active THEN COALESCE(catalog_provider_integration_profile_versions.activated_at, now()) ELSE catalog_provider_integration_profile_versions.activated_at END,
       deprecated_at = CASE WHEN EXCLUDED.lifecycle = 'deprecated' THEN COALESCE(catalog_provider_integration_profile_versions.deprecated_at, now()) ELSE catalog_provider_integration_profile_versions.deprecated_at END,
       retired_at = CASE WHEN EXCLUDED.lifecycle = 'retired' THEN COALESCE(catalog_provider_integration_profile_versions.retired_at, now()) ELSE catalog_provider_integration_profile_versions.retired_at END,
       updated_at = now()
     RETURNING *`,
    [
      version.providerKey,
      version.profileKey,
      version.profileVersion,
      version.lifecycle,
      version.active,
      JSON.stringify(version.profile),
      JSON.stringify(version.sourceContract),
      JSON.stringify(version.fixtures),
      version.retirementPlan === null ? null : JSON.stringify(version.retirementPlan),
      version.executableMappingContract ? JSON.stringify(version.executableMappingContract) : null,
      version.migrationEvidence ? JSON.stringify(version.migrationEvidence) : null,
      version.authoringAudit ? JSON.stringify(version.authoringAudit) : null,
    ],
  );

  const persisted = rowToProfileVersion(result.rows[0] ?? rowFromVersion(version));
  await refreshCatalogProviderProfileVersionSectionProjections(db, persisted);
  return persisted;
}

async function deactivateOtherActiveProfileVersions(
  db: PgQueryable,
  version: Pick<CatalogProviderIntegrationProfileVersionRecord, "providerKey" | "profileVersion">,
): Promise<void> {
  const result = await db.query<CatalogProviderIntegrationProfileVersionRow>(
    `UPDATE catalog_provider_integration_profile_versions
     SET active = false,
         lifecycle = 'deprecated',
         deprecated_at = COALESCE(deprecated_at, now()),
         updated_at = now()
     WHERE provider_key = $1
       AND profile_version <> $2
       AND active = true
       AND lifecycle = 'active'
     RETURNING *`,
    [version.providerKey, version.profileVersion],
  );

  for (const row of result.rows) {
    await refreshCatalogProviderProfileVersionSectionProjections(db, rowToProfileVersion(row));
  }
}

async function assertSeededActiveProfileVersions(
  db: PgQueryable,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
): Promise<void> {
  const providersRequiringActiveRows = Array.from(
    new Set(
      versions
        .filter((version) => version.active && version.lifecycle === "active")
        .map((version) => version.providerKey),
    ),
  );

  for (const providerKey of providersRequiringActiveRows) {
    const active = await getActiveProfileVersion(db, providerKey);
    if (!active) {
      throw new Error(
        `Catalog provider integration bootstrap requires an active profile row for provider '${providerKey}'. Restore or activate a provider profile version before imports can run.`,
      );
    }
  }
}

async function listProfileVersions(
  db: PgQueryable,
  providerKey?: string | null,
): Promise<readonly CatalogProviderIntegrationProfileVersionRecord[]> {
  const normalizedProviderKey = providerKey?.trim().toLowerCase() ?? "";
  const result =
    normalizedProviderKey.length > 0
      ? await db.query<CatalogProviderIntegrationProfileVersionRow>(
          `SELECT *
           FROM catalog_provider_integration_profile_versions
           WHERE provider_key = $1
           ORDER BY provider_key ASC, profile_version DESC`,
          [normalizedProviderKey],
        )
      : await db.query<CatalogProviderIntegrationProfileVersionRow>(
          `SELECT *
           FROM catalog_provider_integration_profile_versions
           ORDER BY provider_key ASC, profile_version DESC`,
        );

  return result.rows.map(rowToProfileVersion);
}

async function getProfileVersion(
  db: PgQueryable,
  providerKey: string,
  profileVersion: string,
): Promise<CatalogProviderIntegrationProfileVersionRecord | null> {
  const result = await db.query<CatalogProviderIntegrationProfileVersionRow>(
    `SELECT *
     FROM catalog_provider_integration_profile_versions
     WHERE provider_key = $1 AND profile_version = $2
     ORDER BY profile_key ASC
     LIMIT 1`,
    [providerKey.trim().toLowerCase(), profileVersion.trim()],
  );

  return result.rows[0] ? rowToProfileVersion(result.rows[0]) : null;
}

async function getActiveProfileVersion(
  db: PgQueryable,
  providerKey: string,
): Promise<CatalogProviderIntegrationProfileVersionRecord | null> {
  const result = await db.query<CatalogProviderIntegrationProfileVersionRow>(
    `SELECT *
     FROM catalog_provider_integration_profile_versions
     WHERE provider_key = $1 AND active = true AND lifecycle = 'active'
     ORDER BY activated_at DESC NULLS LAST, profile_version DESC
     LIMIT 1`,
    [providerKey.trim().toLowerCase()],
  );

  return result.rows[0] ? rowToProfileVersion(result.rows[0]) : null;
}

async function activateProfileVersion(
  db: PgQueryable,
  providerKey: string,
  profileVersion: string,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const existingVersions = await listProfileVersions(db, providerKey);
  const activatedVersions = activateCatalogProviderIntegrationProfileVersion(
    providerKey,
    profileVersion,
    existingVersions,
  );
  const changedVersions = activatedVersions.filter((version) => {
    const prior = existingVersions.find(
      (candidate) =>
        candidate.providerKey === version.providerKey &&
        candidate.profileKey === version.profileKey &&
        candidate.profileVersion === version.profileVersion,
    );
    return !prior || prior.lifecycle !== version.lifecycle || prior.active !== version.active;
  });

  for (const changedVersion of [...changedVersions].sort((left, right) => Number(left.active) - Number(right.active))) {
    await upsertProfileVersion(db, changedVersion);
  }

  const activated = activatedVersions.find((version) => version.profileVersion === profileVersion);
  if (!activated) {
    throw new Error(`Catalog provider profile version ${providerKey}@${profileVersion} was not activated.`);
  }
  return activated;
}

async function deprecateProfileVersion(
  db: PgQueryable,
  providerKey: string,
  profileVersion: string,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const existing = await getProfileVersion(db, providerKey, profileVersion);
  if (!existing) {
    throw new Error(`Catalog provider profile version ${providerKey}@${profileVersion} was not found.`);
  }

  const deprecated: CatalogProviderIntegrationProfileVersionRecord = {
    ...existing,
    lifecycle: "deprecated",
    active: false,
    executableMappingContract: existing.executableMappingContract
      ? {
          ...existing.executableMappingContract,
          lifecycle: "deprecated",
        }
      : undefined,
  };

  return upsertProfileVersion(db, deprecated);
}

async function countProfileVersionReferences(
  db: PgQueryable,
  providerKey: string,
  profileVersion: string,
): Promise<number> {
  const result = await db.query<{ reference_count: number | string }>(
    `SELECT COUNT(*) AS reference_count
     FROM catalog_source_observations
     WHERE provider_key = $1
       AND (
         source_profile_version = $2
         OR promotion_profile_version = $2
       )`,
    [providerKey.trim().toLowerCase(), profileVersion.trim()],
  );

  return Number(result.rows[0]?.reference_count ?? 0);
}

function rowToProfileVersion(
  row: CatalogProviderIntegrationProfileVersionRow,
): CatalogProviderIntegrationProfileVersionRecord {
  return {
    providerKey: row.provider_key,
    profileKey: row.profile_key,
    profileVersion: row.profile_version,
    lifecycle: row.lifecycle,
    active: row.active,
    profile: parseJsonField<CatalogProviderIntegrationProfile>(row.profile_json),
    sourceContract: parseJsonField<CatalogProviderMappingSourceContract>(row.source_contract_json),
    fixtures: parseJsonField<CatalogProviderProfileFixtureContract>(row.fixture_contract_json),
    retirementPlan: row.retirement_plan_json
      ? parseJsonField<CatalogProviderIntegrationProfileRetirementPlan>(row.retirement_plan_json)
      : null,
    executableMappingContract: row.executable_mapping_contract_json
      ? parseJsonField<CatalogProviderExecutableMappingContract>(row.executable_mapping_contract_json)
      : undefined,
    migrationEvidence: row.migration_evidence_json
      ? parseJsonField<CatalogProviderIntegrationProfileMigrationEvidence>(row.migration_evidence_json)
      : null,
    authoringAudit: row.authoring_audit_json
      ? parseJsonField<CatalogProviderIntegrationProfileAuthoringAudit>(row.authoring_audit_json)
      : null,
  };
}

function rowFromVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogProviderIntegrationProfileVersionRow {
  return {
    provider_key: version.providerKey,
    profile_key: version.profileKey,
    profile_version: version.profileVersion,
    lifecycle: version.lifecycle,
    active: version.active,
    profile_json: version.profile,
    source_contract_json: version.sourceContract,
    fixture_contract_json: version.fixtures,
    retirement_plan_json: version.retirementPlan,
    executable_mapping_contract_json: version.executableMappingContract ?? null,
    migration_evidence_json: version.migrationEvidence ?? null,
    authoring_audit_json: version.authoringAudit ?? null,
  };
}

function parseJsonField<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

async function withOptionalProfileVersionTransaction<T>(
  db: PgQueryable,
  work: (queryable: PgQueryable) => Promise<T>,
): Promise<T> {
  if (isTransactionalPool(db)) {
    return withPgTransaction(db, work);
  }

  return work(db);
}

function isTransactionalPool(db: PgQueryable): db is PgTransactionalPool {
  return "connect" in db && typeof db.connect === "function";
}
