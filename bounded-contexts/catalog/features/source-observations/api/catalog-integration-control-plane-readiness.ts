import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  catalogProviderProfileVersionIngestionUnitKey,
  type CatalogProviderIntegrationProfileVersionRecord,
  type CatalogProviderProfileVersionSelector,
} from "./provider-integration-profiles";
import type {
  SourceObservationLorcanaSetReferenceNormalized,
  SourceObservationMagicSetReferenceNormalized,
  SourceObservationNormalized,
  SourceObservationOnePieceSetReferenceNormalized,
} from "../domain/domain";
import type { SourceObservationDetailRow } from "../read-model/queries";
import {
  createCatalogIntegrationDryRunProofRegistry,
  type CatalogIntegrationDryRunProofRegistry,
} from "./catalog-integration-dry-run-proofs";
import {
  catalogProviderCredentialReadinessToTransportDiagnostic,
  type CatalogProviderCredentialReadiness,
  type CatalogProviderCredentialRequirement,
  type CatalogProviderCredentialReadinessState,
} from "./catalog-integration-credential-readiness";
import {
  createCatalogIntegrationRolloutControlPolicyFromEnv,
  type CatalogIntegrationRolloutControlPolicy,
} from "./catalog-integration-rollout-controls";
import { ProviderAdapterRegistry } from "./provider-adapters/registry";
import type { ProviderTransportDiagnostic } from "./provider-adapters/provider-adapter";
import { resolveCatalogProviderDuplicatePrevention } from "./provider-duplicate-prevention-resolver";
import type {
  CatalogIntegrationControlPlaneReadiness,
  CatalogIntegrationControlPlaneUnitReadiness,
  CatalogIntegrationControlPlaneDiagnostic,
  SourceObservationReapplyProfileMode,
  SourceObservationSelectedOptionAuthoringSchema,
  SourceObservationPromotionTargetAuthoringSchema,
  SourceObservationPromotionTargetAuthoringRecord,
  SourceObservationDuplicatePreventionCandidatePreview,
  CatalogProviderIntegrationProfileVersionReader,
  SourceObservationIntegrationProfileSnapshot,
} from "./source-observation-runtime-contracts";

export async function buildCatalogIntegrationControlPlaneReadiness(
  providerAdapterRegistry: ProviderAdapterRegistry,
  dryRunProofRegistry: CatalogIntegrationDryRunProofRegistry = createCatalogIntegrationDryRunProofRegistry(),
  rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy = createCatalogIntegrationRolloutControlPolicyFromEnv(),
): Promise<CatalogIntegrationControlPlaneReadiness> {
  const units: CatalogIntegrationControlPlaneUnitReadiness[] = [];
  const rolloutControls = rolloutControlPolicy.snapshot();

  for (const providerKey of providerAdapterRegistry.listProviderKeys()) {
    const adapter = providerAdapterRegistry.require(providerKey);
    const [descriptors, transportDiagnostics, credentialReadiness] = await Promise.all([
      adapter.listIntegrationUnits(),
      adapter.getTransportDiagnostics(),
      adapter.getCredentialReadiness(),
    ]);

    for (const descriptor of descriptors) {
      const dryRun = (await dryRunProofRegistry.get(descriptor.unitKey)?.()) ?? null;
      const dryRunDiagnostics =
        dryRun?.diagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          severity: diagnostic.severity,
          message: diagnostic.diagnosticText,
          unitKey: diagnostic.unitKey,
          retryAfterSeconds: undefined,
        })) ?? [];
      const unitCredentialReadiness = selectUnitCredentialReadiness(credentialReadiness, descriptor.unitKey);
      const credentialDiagnostics = unitCredentialReadiness
        .map(catalogProviderCredentialReadinessToTransportDiagnostic)
        .filter((diagnostic): diagnostic is ProviderTransportDiagnostic => diagnostic !== null);
      const providerDiagnostics = [
        ...transportDiagnostics.filter(
          (diagnostic) => !diagnostic.unitKey || diagnostic.unitKey === descriptor.unitKey,
        ),
        ...credentialDiagnostics,
      ].map((diagnostic) => toControlPlaneDiagnostic(diagnostic, "provider-adapter"));
      const rolloutDiagnostics = rolloutControlDiagnosticsForUnit(rolloutControlPolicy, {
        providerKey: descriptor.providerKey,
        unitKey: descriptor.unitKey,
      });
      const catalogDiagnostics = dryRunDiagnostics.map((diagnostic) => toControlPlaneDiagnostic(diagnostic, "catalog"));
      const unitDiagnostics = [...providerDiagnostics, ...catalogDiagnostics, ...rolloutDiagnostics];
      const errorCount = countDiagnostics(unitDiagnostics, "error");
      const dryRunErrorCount = countDiagnostics(catalogDiagnostics, "error");
      const credentialStatus = summarizeUnitCredentialReadiness(unitCredentialReadiness);
      const transportRolloutBlocked = rolloutControlPolicy.decide({
        capability: "provider-transport",
        providerKey: descriptor.providerKey,
        unitKey: descriptor.unitKey,
      }).allowed
        ? false
        : true;

      units.push({
        unitKey: descriptor.unitKey,
        providerKey: descriptor.providerKey,
        displayName: descriptor.displayName,
        productDomain: descriptor.productDomain,
        productForm: descriptor.productForm,
        ingestionPurpose: descriptor.ingestionPurpose ?? null,
        profileVersion: descriptor.profileVersion ?? "",
        semanticReadiness: dryRun && dryRunErrorCount === 0 && dryRun.observations.length > 0 ? "ready" : "blocked",
        credentialReadiness: credentialStatus.readiness,
        credentialReadinessState: credentialStatus.state,
        credentialRequirement: credentialStatus.requirement,
        credentialDiagnosticCode: credentialStatus.diagnosticCode,
        transportReadiness:
          !transportRolloutBlocked && countDiagnostics(providerDiagnostics, "error") === 0 ? "ready" : "blocked",
        fixtureValidationStatus: dryRun && dryRun.observations.length > 0 ? "ready" : "blocked",
        dryRunStatus: dryRun && dryRunErrorCount === 0 ? "completed" : "blocked",
        observationFacts: dryRun?.observations.length ?? 0,
        diagnosticCounts: {
          info: countDiagnostics(unitDiagnostics, "info"),
          warning: countDiagnostics(unitDiagnostics, "warning"),
          error: errorCount,
        },
        diagnostics: unitDiagnostics,
        latestDiagnosticText: unitDiagnostics.at(-1)?.message ?? null,
        dryRunEvidence:
          dryRun?.observations.map((observation) => ({
            externalKey: observation.externalKey,
            sourceUrl: observation.sourceUrl ?? null,
            sourceHash: observation.sourceHash ?? null,
            normalizedFacts: observation.normalizedFacts,
          })) ?? [],
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    rolloutControls,
    units,
  };
}

export function rolloutControlDiagnosticsForUnit(
  rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy,
  input: Readonly<{ providerKey: string; unitKey: string }>,
): readonly CatalogIntegrationControlPlaneDiagnostic[] {
  const controls = [
    rolloutControlPolicy.decide({
      capability: "provider-transport",
      providerKey: input.providerKey,
      unitKey: input.unitKey,
    }),
    rolloutControlPolicy.decide({
      capability: "provider-option-query",
      providerKey: input.providerKey,
      unitKey: input.unitKey,
    }),
    rolloutControlPolicy.decide({
      capability: "import",
      providerKey: input.providerKey,
      unitKey: input.unitKey,
    }),
  ].flatMap((decision) => decision.controls);
  const uniqueControls = new Map(controls.map((control) => [control.controlId, control]));

  return [...uniqueControls.values()].map((control) => ({
    code: "catalog-integration-rollout-control-denied",
    severity: control.severity === "error" ? "error" : "warning",
    message: control.message,
    unitKey: input.unitKey,
    retryAfterSeconds: null,
    source: "catalog",
  }));
}

export function selectUnitCredentialReadiness(
  readiness: readonly CatalogProviderCredentialReadiness[],
  unitKey: string,
): readonly CatalogProviderCredentialReadiness[] {
  const attributed = readiness.filter((item) => item.unitKey === unitKey);
  return attributed.length > 0 ? attributed : readiness.filter((item) => !item.unitKey);
}

export function summarizeUnitCredentialReadiness(readiness: readonly CatalogProviderCredentialReadiness[]): Readonly<{
  readiness: "ready" | "blocked" | "not-required";
  state: CatalogProviderCredentialReadinessState;
  requirement: CatalogProviderCredentialRequirement;
  diagnosticCode: string | null;
}> {
  if (readiness.length === 0) {
    return {
      readiness: "blocked",
      state: "unknown",
      requirement: "required",
      diagnosticCode: "adapter-authentication-failed",
    };
  }

  const blocker = readiness.find((item) => item.importBlocking);
  if (blocker) {
    return {
      readiness: "blocked",
      state: blocker.state,
      requirement: blocker.requirement,
      diagnosticCode: blocker.diagnosticCode,
    };
  }

  const required = readiness.find((item) => item.requirement === "required");
  if (required) {
    return {
      readiness: "ready",
      state: required.state,
      requirement: required.requirement,
      diagnosticCode: required.diagnosticCode,
    };
  }

  const notRequired = readiness.find((item) => item.state === "not-required");
  return {
    readiness: "not-required",
    state: notRequired?.state ?? "unknown",
    requirement: notRequired?.requirement ?? "not-required",
    diagnosticCode: notRequired?.diagnosticCode ?? null,
  };
}

export function countDiagnostics(
  diagnostics: readonly Pick<CatalogIntegrationControlPlaneDiagnostic, "severity">[],
  severity: CatalogIntegrationControlPlaneDiagnostic["severity"],
): number {
  return diagnostics.filter((diagnostic) => diagnostic.severity === severity).length;
}

export function toControlPlaneDiagnostic(
  diagnostic: Pick<ProviderTransportDiagnostic, "code" | "severity" | "message" | "unitKey" | "retryAfterSeconds">,
  source: CatalogIntegrationControlPlaneDiagnostic["source"],
): CatalogIntegrationControlPlaneDiagnostic {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    unitKey: diagnostic.unitKey ?? null,
    retryAfterSeconds: diagnostic.retryAfterSeconds ?? null,
    source,
  };
}

export function normalizeIntegrationKey(value: string): string {
  return value.trim().toLowerCase();
}

export function profileConnectorSourceVersion(
  connector: CatalogProviderIntegrationProfileVersionRecord["profile"]["connector"],
): string | null {
  if ("sourceRepository" in connector) {
    return connector.sourceRepository.commit;
  }
  if ("sourceContractDocument" in connector) {
    return connector.sourceContractDocument;
  }

  return null;
}

export function normalizeReapplyProfileMode(
  mode: SourceObservationReapplyProfileMode | null | undefined,
): SourceObservationReapplyProfileMode | null {
  return mode === "current-active-profile" || mode === "original-source-profile" ? mode : null;
}

export function isActiveSourceObservationImportProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): boolean {
  return (
    version.active &&
    version.lifecycle === "active" &&
    version.profile.status === "active" &&
    version.profile.capabilities.includes("source-observation-import")
  );
}

export function isActiveProviderOptionQueryProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): boolean {
  return (
    version.active &&
    version.lifecycle === "active" &&
    version.profile.status === "active" &&
    version.profile.capabilities.includes("provider-option-query")
  );
}

type CatalogIntegrationProfileVersionResolverDependencies = Readonly<{
  defaultSourceObservationImportProviderKey: (
    profileVersions: CatalogProviderIntegrationProfileVersionReader,
  ) => Promise<string>;
  isActivePromotionProfileVersion: (version: CatalogProviderIntegrationProfileVersionRecord) => boolean;
  requireCatalogPromotionProfileVersion: (
    profileVersions: CatalogProviderIntegrationProfileVersionReader,
    providerKey: string,
    normalized: SourceObservationNormalized,
    selector?: CatalogProviderProfileVersionSelector | null,
  ) => Promise<CatalogProviderIntegrationProfileVersionRecord>;
  requireReferenceDataPromotionProfileVersion: (
    profileVersions: CatalogProviderIntegrationProfileVersionReader,
    providerKey: string,
    normalized:
      | SourceObservationMagicSetReferenceNormalized
      | SourceObservationLorcanaSetReferenceNormalized
      | SourceObservationOnePieceSetReferenceNormalized,
    selector?: CatalogProviderProfileVersionSelector | null,
  ) => Promise<CatalogProviderIntegrationProfileVersionRecord>;
  requireOriginalSourceProfileMarker: (
    value: string | null | undefined,
    label: string,
    observationId: string,
  ) => string;
  sourceMappingFingerprintForProfileVersion: (version: CatalogProviderIntegrationProfileVersionRecord) => string;
}>;

export function createCatalogIntegrationProfileVersionResolvers(
  dependencies: CatalogIntegrationProfileVersionResolverDependencies,
) {
  async function requireCatalogImportProfileVersion(
    profileVersions: CatalogProviderIntegrationProfileVersionReader,
    providerKey: string | null | undefined,
    selector?: CatalogProviderProfileVersionSelector | null,
  ): Promise<CatalogProviderIntegrationProfileVersionRecord> {
    const normalizedProvider = normalizeIntegrationKey(
      providerKey || (await dependencies.defaultSourceObservationImportProviderKey(profileVersions)),
    );
    const version = await profileVersions.getActiveProfileVersion(normalizedProvider, selector);
    if (!version || !isActiveSourceObservationImportProfileVersion(version)) {
      throw new Error(`Provider '${normalizedProvider}' does not support background import.`);
    }

    return version;
  }

  async function requireCatalogImportProfileVersionForJob(
    profileVersions: CatalogProviderIntegrationProfileVersionReader,
    providerKey: string | null | undefined,
    snapshot: SourceObservationIntegrationProfileSnapshot | null,
    selector?: CatalogProviderProfileVersionSelector | null,
  ): Promise<CatalogProviderIntegrationProfileVersionRecord> {
    if (!snapshot) {
      return requireCatalogImportProfileVersion(profileVersions, providerKey, selector);
    }

    const versions = await profileVersions.listProfileVersions(snapshot.providerKey);
    const version = versions.find(
      (candidate) =>
        candidate.providerKey === snapshot.providerKey &&
        candidate.profileKey === snapshot.profileKey &&
        candidate.profileVersion === snapshot.profileVersion &&
        (!snapshot.ingestionUnitKey ||
          catalogProviderProfileVersionIngestionUnitKey(candidate) === snapshot.ingestionUnitKey),
    );
    if (!version) {
      throw new Error(
        `Catalog provider profile version ${snapshot.providerKey}@${snapshot.profileVersion} from the integration job snapshot was not found.`,
      );
    }
    if (!version.profile.capabilities.includes("source-observation-import")) {
      throw new Error(`Provider '${snapshot.providerKey}' does not support background import.`);
    }

    return version;
  }

  async function requireCatalogReapplyActiveProfileVersion(
    profileVersions: CatalogProviderIntegrationProfileVersionReader,
    providerKey: string | null | undefined,
    selector?: CatalogProviderProfileVersionSelector | null,
  ): Promise<CatalogProviderIntegrationProfileVersionRecord> {
    const normalizedProvider = normalizeIntegrationKey(
      providerKey || (await dependencies.defaultSourceObservationImportProviderKey(profileVersions)),
    );
    const providerProfile = await profileVersions.getActiveProfileVersion(normalizedProvider, selector);
    if (providerProfile && dependencies.isActivePromotionProfileVersion(providerProfile)) {
      return providerProfile;
    }

    throw new Error(`Provider '${normalizedProvider}' does not support Catalog Item promotion.`);
  }

  async function requireCatalogPromotionProfileVersionForReapply(
    profileVersions: CatalogProviderIntegrationProfileVersionReader,
    observation: SourceObservationDetailRow,
    normalized: SourceObservationNormalized,
    mode: SourceObservationReapplyProfileMode,
    snapshot: SourceObservationIntegrationProfileSnapshot | null,
  ): Promise<CatalogProviderIntegrationProfileVersionRecord> {
    if (mode === "current-active-profile") {
      if (snapshot) {
        return requireCatalogPromotionProfileVersionFromSnapshot(profileVersions, snapshot, normalized);
      }
      return dependencies.requireCatalogPromotionProfileVersion(profileVersions, observation.provider_key, normalized);
    }

    const sourceProfileKey = dependencies
      .requireOriginalSourceProfileMarker(
        observation.source_profile_key,
        "source profile key",
        observation.observation_id,
      )
      .toLowerCase();
    const sourceProfileVersion = dependencies.requireOriginalSourceProfileMarker(
      observation.source_profile_version,
      "source profile version",
      observation.observation_id,
    );
    dependencies.requireOriginalSourceProfileMarker(
      observation.source_mapping_fingerprint,
      "source mapping fingerprint",
      observation.observation_id,
    );

    const version = (await profileVersions.listProfileVersions(observation.provider_key)).find(
      (candidate) =>
        candidate.providerKey === observation.provider_key &&
        candidate.profileKey === sourceProfileKey &&
        candidate.profileVersion === sourceProfileVersion,
    );
    if (!version) {
      throw new Error(
        `Catalog provider profile version ${observation.provider_key}@${sourceProfileVersion} from Source Observation ${observation.observation_id} was not found.`,
      );
    }

    assertPromotionProfileCompatible(version, normalized);
    return version;
  }

  async function requireReferenceDataPromotionProfileVersionForReapply(
    profileVersions: CatalogProviderIntegrationProfileVersionReader,
    observation: SourceObservationDetailRow,
    normalized:
      | SourceObservationMagicSetReferenceNormalized
      | SourceObservationLorcanaSetReferenceNormalized
      | SourceObservationOnePieceSetReferenceNormalized,
    mode: SourceObservationReapplyProfileMode,
    snapshot: SourceObservationIntegrationProfileSnapshot | null,
  ): Promise<CatalogProviderIntegrationProfileVersionRecord> {
    if (mode === "current-active-profile") {
      if (snapshot) {
        return requireReferenceDataPromotionProfileVersionFromSnapshot(profileVersions, snapshot, normalized);
      }
      return dependencies.requireReferenceDataPromotionProfileVersion(
        profileVersions,
        observation.provider_key,
        normalized,
      );
    }

    const sourceProfileKey = dependencies
      .requireOriginalSourceProfileMarker(
        observation.source_profile_key,
        "source profile key",
        observation.observation_id,
      )
      .toLowerCase();
    const sourceProfileVersion = dependencies.requireOriginalSourceProfileMarker(
      observation.source_profile_version,
      "source profile version",
      observation.observation_id,
    );
    dependencies.requireOriginalSourceProfileMarker(
      observation.source_mapping_fingerprint,
      "source mapping fingerprint",
      observation.observation_id,
    );

    const version = (await profileVersions.listProfileVersions(observation.provider_key)).find(
      (candidate) =>
        candidate.providerKey === observation.provider_key &&
        candidate.profileKey === sourceProfileKey &&
        candidate.profileVersion === sourceProfileVersion,
    );
    if (!version) {
      throw new Error(
        `Catalog provider profile version ${observation.provider_key}@${sourceProfileVersion} from Source Observation ${observation.observation_id} was not found.`,
      );
    }

    assertReferenceDataPromotionProfileCompatible(version, normalized);
    return version;
  }

  async function requireCatalogPromotionProfileVersionFromSnapshot(
    profileVersions: CatalogProviderIntegrationProfileVersionReader,
    snapshot: SourceObservationIntegrationProfileSnapshot,
    normalized: SourceObservationNormalized,
  ): Promise<CatalogProviderIntegrationProfileVersionRecord> {
    const version = await findCatalogProfileVersionFromSnapshot(profileVersions, snapshot);
    if (!version) {
      throw new Error(
        `Catalog provider profile version ${snapshot.providerKey}@${snapshot.profileVersion} from the integration job snapshot was not found.`,
      );
    }

    assertPromotionProfileCompatible(version, normalized);
    return version;
  }

  async function requireReferenceDataPromotionProfileVersionFromSnapshot(
    profileVersions: CatalogProviderIntegrationProfileVersionReader,
    snapshot: SourceObservationIntegrationProfileSnapshot,
    normalized:
      | SourceObservationMagicSetReferenceNormalized
      | SourceObservationLorcanaSetReferenceNormalized
      | SourceObservationOnePieceSetReferenceNormalized,
  ): Promise<CatalogProviderIntegrationProfileVersionRecord> {
    const version = await findCatalogProfileVersionFromSnapshot(profileVersions, snapshot);
    if (!version) {
      throw new Error(
        `Catalog provider profile version ${snapshot.providerKey}@${snapshot.profileVersion} from the integration job snapshot was not found.`,
      );
    }

    assertReferenceDataPromotionProfileCompatible(version, normalized);
    return version;
  }

  async function findCatalogProfileVersionFromSnapshot(
    profileVersions: CatalogProviderIntegrationProfileVersionReader,
    snapshot: SourceObservationIntegrationProfileSnapshot,
  ): Promise<CatalogProviderIntegrationProfileVersionRecord | null> {
    const versions = await profileVersions.listProfileVersions(snapshot.providerKey);
    return (
      versions.find(
        (candidate) =>
          candidate.providerKey === snapshot.providerKey &&
          candidate.profileKey === snapshot.profileKey &&
          candidate.profileVersion === snapshot.profileVersion &&
          (!snapshot.ingestionUnitKey ||
            catalogProviderProfileVersionIngestionUnitKey(candidate) === snapshot.ingestionUnitKey),
      ) ?? null
    );
  }

  function assertPromotionProfileCompatible(
    version: CatalogProviderIntegrationProfileVersionRecord,
    normalized: SourceObservationNormalized,
  ): void {
    if (!version.profile.capabilities.includes("catalog-item-promotion")) {
      throw new Error(`Provider '${version.providerKey}' does not support Catalog Item promotion.`);
    }
    if (version.profile.normalizedObservationMapping.kind !== normalized.kind) {
      throw new Error(
        `Provider '${version.providerKey}' promotion mapping '${version.profile.normalizedObservationMapping.kind}' is not compatible with '${normalized.kind}' observations.`,
      );
    }
  }

  function assertReferenceDataPromotionProfileCompatible(
    version: CatalogProviderIntegrationProfileVersionRecord,
    normalized:
      | SourceObservationMagicSetReferenceNormalized
      | SourceObservationLorcanaSetReferenceNormalized
      | SourceObservationOnePieceSetReferenceNormalized,
  ): void {
    if (!version.profile.capabilities.includes("reference-data-promotion")) {
      throw new Error(`Provider '${version.providerKey}' does not support Reference Data promotion.`);
    }
    if (version.profile.normalizedObservationMapping.kind !== normalized.kind) {
      throw new Error(
        `Provider '${version.providerKey}' reference promotion mapping '${version.profile.normalizedObservationMapping.kind}' is not compatible with '${normalized.kind}' observations.`,
      );
    }
  }

  function snapshotCatalogProfileVersion(
    version: CatalogProviderIntegrationProfileVersionRecord,
  ): SourceObservationIntegrationProfileSnapshot {
    return {
      providerKey: version.providerKey,
      profileKey: version.profileKey,
      profileVersion: version.profileVersion,
      ingestionUnitKey: catalogProviderProfileVersionIngestionUnitKey(version),
      lifecycle: version.lifecycle,
      connectorKind: version.profile.connector.kind,
      connectorSourceVersion: profileConnectorSourceVersion(version.profile.connector),
      sourceMappingFingerprint: dependencies.sourceMappingFingerprintForProfileVersion(version),
    };
  }

  function snapshotCatalogReapplyProfileVersion(
    version: CatalogProviderIntegrationProfileVersionRecord,
  ): SourceObservationIntegrationProfileSnapshot {
    return snapshotCatalogProfileVersion(version);
  }

  function integrationProfileSnapshotKey(
    snapshot: SourceObservationIntegrationProfileSnapshot | null,
    owner: string,
  ): string {
    if (!snapshot) {
      throw new Error(`Source Observation integration job ${owner} is missing profile snapshot.`);
    }
    return `${snapshot.providerKey}:${snapshot.profileKey}:${snapshot.profileVersion}:${snapshot.ingestionUnitKey ?? "legacy-unit"}`;
  }

  function commonProfileSnapshot(
    snapshots: readonly (SourceObservationIntegrationProfileSnapshot | null)[],
  ): SourceObservationIntegrationProfileSnapshot | null {
    let common: SourceObservationIntegrationProfileSnapshot | null = null;

    for (const snapshot of snapshots) {
      if (!snapshot) {
        continue;
      }
      if (!common) {
        common = snapshot;
        continue;
      }
      if (
        snapshot.providerKey !== common.providerKey ||
        snapshot.profileKey !== common.profileKey ||
        snapshot.profileVersion !== common.profileVersion ||
        (snapshot.ingestionUnitKey ?? null) !== (common.ingestionUnitKey ?? null)
      ) {
        return null;
      }
    }

    return common;
  }

  return {
    requireCatalogImportProfileVersion,
    requireCatalogImportProfileVersionForJob,
    requireCatalogReapplyActiveProfileVersion,
    requireCatalogPromotionProfileVersionForReapply,
    requireReferenceDataPromotionProfileVersionForReapply,
    snapshotCatalogProfileVersion,
    snapshotCatalogReapplyProfileVersion,
    integrationProfileSnapshotKey,
    commonProfileSnapshot,
  };
}

export async function loadSelectedOptionAuthoringSchema(
  db: PgQueryable,
): Promise<SourceObservationSelectedOptionAuthoringSchema> {
  const result = await db.query<{
    dimension_id: string;
    dimension_key: string;
    dimension_name: string;
    dimension_status: string;
    option_id: string | null;
    option_key: string | null;
    option_label: string | null;
    option_status: string | null;
    display_order: number | null;
  }>(
    `SELECT
       dimension.dimension_id,
       dimension.key AS dimension_key,
       dimension.name AS dimension_name,
       dimension.status AS dimension_status,
       option.option_id,
       option.code AS option_key,
       option.label AS option_label,
       option.status AS option_status,
       option.display_order
     FROM catalog_dimensions AS dimension
     LEFT JOIN catalog_dimension_options AS option
       ON option.dimension_id = dimension.dimension_id
     ORDER BY dimension.key ASC, option.display_order ASC, option.code ASC`,
  );

  const dimensions = new Map<string, SourceObservationSelectedOptionAuthoringSchema["dimensions"][number]>();
  const optionsByDimensionId = new Map<
    string,
    SourceObservationSelectedOptionAuthoringSchema["dimensions"][number]["options"][number][]
  >();

  for (const row of result.rows) {
    if (!dimensions.has(row.dimension_id)) {
      dimensions.set(row.dimension_id, {
        dimensionId: row.dimension_id,
        dimensionKey: row.dimension_key,
        dimensionName: row.dimension_name,
        status: row.dimension_status,
        options: [],
      });
      optionsByDimensionId.set(row.dimension_id, []);
    }

    if (row.option_id) {
      optionsByDimensionId.get(row.dimension_id)?.push({
        optionId: row.option_id,
        optionKey: row.option_key ?? row.option_id,
        optionLabel: row.option_label ?? row.option_key ?? row.option_id,
        status: row.option_status ?? "unknown",
      });
    }
  }

  return {
    dimensions: [...dimensions.values()].map((dimension) => ({
      ...dimension,
      options: optionsByDimensionId.get(dimension.dimensionId) ?? [],
    })),
  };
}

export async function loadPromotionTargetAuthoringSchema(
  db: PgQueryable,
): Promise<SourceObservationPromotionTargetAuthoringSchema> {
  const [blueprints, categories, fields] = await Promise.all([
    loadPromotionTargetAuthoringRecords(db, "catalog_blueprints", "blueprint_id"),
    loadPromotionTargetAuthoringRecords(db, "catalog_categories", "category_id"),
    loadPromotionTargetAuthoringRecords(db, "catalog_fields", "field_id"),
  ]);

  return { blueprints, categories, fields };
}

export async function loadPromotionTargetAuthoringRecords(
  db: PgQueryable,
  tableName: "catalog_blueprints" | "catalog_categories" | "catalog_fields",
  idColumnName: "blueprint_id" | "category_id" | "field_id",
): Promise<readonly SourceObservationPromotionTargetAuthoringRecord[]> {
  const result = await db.query<{
    id: string;
    key: string;
    name: string;
    status: string;
  }>(
    `SELECT ${idColumnName} AS id, key, name, status
     FROM ${tableName}
     ORDER BY key ASC`,
  );

  return result.rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    status: row.status,
  }));
}

export function duplicatePreventionCandidatePreview(
  result: Awaited<ReturnType<typeof resolveCatalogProviderDuplicatePrevention>>,
): SourceObservationDuplicatePreventionCandidatePreview {
  if (result.status === "none") {
    return {
      status: "none",
      ruleKey: null,
      candidateCount: 0,
      candidateCatalogItemIds: [],
      diagnosticText: null,
      evidenceSummary: null,
      evidenceSummaries: result.evidenceSummaries,
    };
  }

  const candidateCatalogItemIds = result.status === "matched" ? [result.catalogItemId] : result.candidateCatalogItemIds;
  return {
    status: result.status,
    ruleKey: result.ruleKey,
    candidateCount: candidateCatalogItemIds.length,
    candidateCatalogItemIds,
    diagnosticText: result.status === "blocked" ? result.diagnosticText : null,
    evidenceSummary: result.evidenceSummary,
    evidenceSummaries: [result.evidenceSummary],
  };
}

export function notEvaluatedDuplicatePreventionPreview(
  diagnosticText: string,
): SourceObservationDuplicatePreventionCandidatePreview {
  return {
    status: "not-evaluated",
    ruleKey: null,
    candidateCount: 0,
    candidateCatalogItemIds: [],
    diagnosticText,
    evidenceSummary: null,
    evidenceSummaries: [],
  };
}
