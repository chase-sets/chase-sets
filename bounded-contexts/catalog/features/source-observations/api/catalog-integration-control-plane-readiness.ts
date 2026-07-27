import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { type CatalogProviderIntegrationProfileVersionRecord } from "./provider-integration-profiles";
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
