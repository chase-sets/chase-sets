import type { CatalogIntegrationGovernedDataClassKey } from "./catalog-integration-data-governance";

export type CatalogIntegrationSchemaCompatibilitySurfaceKey =
  | "provider-adapter-contract"
  | "provider-payload-provenance-envelope"
  | "provider-profile-version"
  | "profile-section-command"
  | "executable-mapping-contract"
  | "catalog-integration-engine-io"
  | "diagnostic-record"
  | "fixture-contract"
  | "admin-control-plane-read-model"
  | "source-observation-record"
  | "integration-durable-job"
  | "integration-work-unit"
  | "audit-evidence-record";

export type CatalogIntegrationWireSchemaVersion =
  | "catalog-provider-adapter-v1"
  | "catalog-provider-payload-provenance-v1"
  | "catalog-provider-profile-version-v1"
  | "catalog-profile-section-command-v1"
  | "catalog-executable-mapping-contract-v1"
  | "catalog-integration-engine-io-v1"
  | "catalog-integration-diagnostic-v1"
  | "catalog-fixture-contract-v1"
  | "catalog-admin-control-plane-read-model-v1"
  | "catalog-source-observation-record-v1"
  | "catalog-integration-durable-job-v1"
  | "catalog-integration-work-unit-v1"
  | "catalog-audit-evidence-record-v1";

export type CatalogIntegrationRetainedDataPolicy =
  | "resettable-pre-launch"
  | "retain-when-referenced"
  | "launched-contract";

export type CatalogIntegrationDeploySkewPolicy =
  | "request-time-current-code"
  | "read-old-write-current"
  | "snapshot-at-enqueue"
  | "projection-can-lag";

export type CatalogIntegrationCompatibilityAdapterOwner =
  | "catalog-source-observations-api"
  | "catalog-source-observations-projection"
  | "catalog-admin-control-plane"
  | "provider-adapter"
  | "platform-durable-job-store";

export type CatalogIntegrationSchemaCompatibilityPolicy = Readonly<{
  key: CatalogIntegrationSchemaCompatibilitySurfaceKey;
  displayName: string;
  wireSchemaVersion: CatalogIntegrationWireSchemaVersion;
  semanticVersionMarkers: readonly string[];
  retainedDataPolicy: CatalogIntegrationRetainedDataPolicy;
  deploySkewPolicy: CatalogIntegrationDeploySkewPolicy;
  compatibilityScope: string;
  adapterOwner: CatalogIntegrationCompatibilityAdapterOwner;
  testExpectation: string;
  resetExceptionRequired: boolean;
  launchBlocking: boolean;
}>;

export const catalogIntegrationSchemaCompatibilityPolicies = [
  {
    key: "provider-adapter-contract",
    displayName: "ProviderAdapter contract and capabilities",
    wireSchemaVersion: "catalog-provider-adapter-v1",
    semanticVersionMarkers: ["adapterKey", "capabilities", "supportedScopes"],
    retainedDataPolicy: "launched-contract",
    deploySkewPolicy: "request-time-current-code",
    compatibilityScope:
      "New optional adapter capabilities may be added without changing Catalog runtime branches; required capability changes need fixtures and readiness diagnostics for old adapters.",
    adapterOwner: "provider-adapter",
    testExpectation:
      "Provider adapter contract tests cover generic integration units without provider-specific core branches.",
    resetExceptionRequired: false,
    launchBlocking: true,
  },
  {
    key: "provider-payload-provenance-envelope",
    displayName: "Provider payload and provenance envelope",
    wireSchemaVersion: "catalog-provider-payload-provenance-v1",
    semanticVersionMarkers: ["providerKey", "connectorKind", "connectorSourceVersion", "sourceUrl"],
    retainedDataPolicy: "resettable-pre-launch",
    deploySkewPolicy: "request-time-current-code",
    compatibilityScope:
      "Raw or sampled provider payloads are not Catalog truth; retained payload bodies require explicit governance and #804 retained-data exceptions.",
    adapterOwner: "provider-adapter",
    testExpectation:
      "Provider fixture and diagnostic tests must prove sensitive or provider-controlled payload fields stay outside Catalog truth.",
    resetExceptionRequired: true,
    launchBlocking: true,
  },
  {
    key: "provider-profile-version",
    displayName: "Provider Integration Profile version row",
    wireSchemaVersion: "catalog-provider-profile-version-v1",
    semanticVersionMarkers: ["providerKey", "profileKey", "profileVersion"],
    retainedDataPolicy: "retain-when-referenced",
    deploySkewPolicy: "read-old-write-current",
    compatibilityScope:
      "Referenced active, deprecated, or retired profile versions remain readable for Source Observation replay, rollback, and audit; unreferenced pre-launch rows may be reset by #804.",
    adapterOwner: "catalog-source-observations-api",
    testExpectation:
      "Profile store tests cover seed reconciliation, referenced-version counting, rollback, and admin-authored row preservation.",
    resetExceptionRequired: false,
    launchBlocking: true,
  },
  {
    key: "profile-section-command",
    displayName: "Profile section command and projection DTO",
    wireSchemaVersion: "catalog-profile-section-command-v1",
    semanticVersionMarkers: ["sectionKey", "sectionFingerprint", "profileVersion"],
    retainedDataPolicy: "resettable-pre-launch",
    deploySkewPolicy: "read-old-write-current",
    compatibilityScope:
      "Section commands write canonical profile versions and projections can be rebuilt; only admin-authored retained profile rows require stale-edit compatibility.",
    adapterOwner: "catalog-admin-control-plane",
    testExpectation:
      "Section registry and projection tests must pin command section keys, fingerprints, and stale-edit behavior.",
    resetExceptionRequired: false,
    launchBlocking: true,
  },
  {
    key: "executable-mapping-contract",
    displayName: "Executable mapping contract",
    wireSchemaVersion: "catalog-executable-mapping-contract-v1",
    semanticVersionMarkers: ["providerKey", "profileKey", "profileVersion", "sourceMappingFingerprint"],
    retainedDataPolicy: "retain-when-referenced",
    deploySkewPolicy: "read-old-write-current",
    compatibilityScope:
      "Mapping contract changes that alter Source Observation identity, hash material, selected Options, references, or promotion plans require migration evidence before activation.",
    adapterOwner: "catalog-source-observations-api",
    testExpectation:
      "Mapping contract and migration guard tests must detect breaking semantic changes and require migration evidence.",
    resetExceptionRequired: false,
    launchBlocking: true,
  },
  {
    key: "catalog-integration-engine-io",
    displayName: "Catalog Integration Engine inputs and outputs",
    wireSchemaVersion: "catalog-integration-engine-io-v1",
    semanticVersionMarkers: ["unitKey", "providerKey", "profileVersion", "sourceMappingFingerprint"],
    retainedDataPolicy: "resettable-pre-launch",
    deploySkewPolicy: "request-time-current-code",
    compatibilityScope:
      "Engine request-time DTOs may evolve additively; persisted outcomes must record profile version and mapping fingerprint when they become Source Observations or job results.",
    adapterOwner: "catalog-source-observations-api",
    testExpectation:
      "Engine tests must prove provider additions use registry/profile data instead of core provider branches.",
    resetExceptionRequired: false,
    launchBlocking: true,
  },
  {
    key: "diagnostic-record",
    displayName: "Diagnostic record and taxonomy",
    wireSchemaVersion: "catalog-integration-diagnostic-v1",
    semanticVersionMarkers: ["code", "severity", "blockingBehavior", "visibility"],
    retainedDataPolicy: "launched-contract",
    deploySkewPolicy: "read-old-write-current",
    compatibilityScope:
      "Diagnostic codes are stable operator and test contracts; new codes must declare severity, remediation, visibility, metrics, and evidence/redaction behavior.",
    adapterOwner: "catalog-source-observations-api",
    testExpectation:
      "Diagnostic taxonomy tests must fail when codes lack blocking, visibility, metrics, or evidence policy.",
    resetExceptionRequired: false,
    launchBlocking: true,
  },
  {
    key: "fixture-contract",
    displayName: "Fixture contract and coverage metadata",
    wireSchemaVersion: "catalog-fixture-contract-v1",
    semanticVersionMarkers: ["fixtureSetVersion", "requiredFlows", "profileVersion"],
    retainedDataPolicy: "resettable-pre-launch",
    deploySkewPolicy: "read-old-write-current",
    compatibilityScope:
      "Fixture metadata is retained with profile versions that require it; unlaunched fixture payload bodies can be reset unless governance marks them retained.",
    adapterOwner: "catalog-source-observations-api",
    testExpectation:
      "Profile contract harness tests must cover required fixture flows and fixture-set version changes.",
    resetExceptionRequired: true,
    launchBlocking: true,
  },
  {
    key: "admin-control-plane-read-model",
    displayName: "Admin Control Plane read model",
    wireSchemaVersion: "catalog-admin-control-plane-read-model-v1",
    semanticVersionMarkers: ["queryKey", "unitKey", "generatedAt"],
    retainedDataPolicy: "launched-contract",
    deploySkewPolicy: "projection-can-lag",
    compatibilityScope:
      "Read models evolve additively and expose degraded/stale states; Admin UI modules must not recover by parsing profile JSON or provider-specific DTOs.",
    adapterOwner: "catalog-admin-control-plane",
    testExpectation:
      "Admin read-model contract tests pin query keys, source inventory, stale states, job consistency, and schema compatibility metadata.",
    resetExceptionRequired: false,
    launchBlocking: true,
  },
  {
    key: "source-observation-record",
    displayName: "Source Observation record",
    wireSchemaVersion: "catalog-source-observation-record-v1",
    semanticVersionMarkers: [
      "providerKey",
      "sourceProfileVersion",
      "sourceMappingFingerprint",
      "promotionProfileVersion",
    ],
    retainedDataPolicy: "retain-when-referenced",
    deploySkewPolicy: "read-old-write-current",
    compatibilityScope:
      "Existing observations remain readable when intentionally retained; source profile version and mapping fingerprint explain replay/reapply behavior.",
    adapterOwner: "catalog-source-observations-projection",
    testExpectation:
      "Projection and query tests must preserve source profile version, promotion profile version, and mapping fingerprint.",
    resetExceptionRequired: false,
    launchBlocking: true,
  },
  {
    key: "integration-durable-job",
    displayName: "Integration durable job payload, progress, and result",
    wireSchemaVersion: "catalog-integration-durable-job-v1",
    semanticVersionMarkers: ["jobKind", "action", "profileSnapshot", "reapplyProfileMode"],
    retainedDataPolicy: "retain-when-referenced",
    deploySkewPolicy: "snapshot-at-enqueue",
    compatibilityScope:
      "Queued/running jobs execute against their snapshotted profile version and additive payload/result fields must tolerate older worker/API versions during deploy skew.",
    adapterOwner: "platform-durable-job-store",
    testExpectation:
      "Runtime job tests must cover profile snapshots, duplicate active-job reuse, retry/resume, partial outcomes, and worker/API skew.",
    resetExceptionRequired: false,
    launchBlocking: true,
  },
  {
    key: "integration-work-unit",
    displayName: "Integration durable work-unit payload and result",
    wireSchemaVersion: "catalog-integration-work-unit-v1",
    semanticVersionMarkers: ["jobId", "unitId", "profileSnapshot", "reapplyProfileMode"],
    retainedDataPolicy: "retain-when-referenced",
    deploySkewPolicy: "snapshot-at-enqueue",
    compatibilityScope:
      "Work units inherit parent job profile snapshots and use stable observation IDs or target IDs so retry/resume does not duplicate completed work.",
    adapterOwner: "platform-durable-job-store",
    testExpectation:
      "Work-unit tests must pin claim state, completed-unit reuse, failed/skipped summaries, and snapshot propagation.",
    resetExceptionRequired: false,
    launchBlocking: true,
  },
  {
    key: "audit-evidence-record",
    displayName: "Audit and evidence record",
    wireSchemaVersion: "catalog-audit-evidence-record-v1",
    semanticVersionMarkers: ["eventName", "providerKey", "profileVersion", "relatedJobId", "relatedObservationId"],
    retainedDataPolicy: "launched-contract",
    deploySkewPolicy: "projection-can-lag",
    compatibilityScope:
      "Audit/evidence records are append-only launched evidence; payload summaries must follow data-governance redaction and remain readable across projection rebuilds.",
    adapterOwner: "catalog-source-observations-projection",
    testExpectation:
      "Audit timeline tests must pin profile, job, observation, actor/account, and redacted evidence summary fields.",
    resetExceptionRequired: false,
    launchBlocking: true,
  },
] as const satisfies readonly CatalogIntegrationSchemaCompatibilityPolicy[];

export const catalogIntegrationSchemaCompatibilityPoliciesByKey: Readonly<
  Record<CatalogIntegrationSchemaCompatibilitySurfaceKey, CatalogIntegrationSchemaCompatibilityPolicy>
> = catalogIntegrationSchemaCompatibilityPolicies.reduce<
  Partial<Record<CatalogIntegrationSchemaCompatibilitySurfaceKey, CatalogIntegrationSchemaCompatibilityPolicy>>
>((policies, policy) => {
  policies[policy.key] = policy;
  return policies;
}, {}) as Readonly<
  Record<CatalogIntegrationSchemaCompatibilitySurfaceKey, CatalogIntegrationSchemaCompatibilityPolicy>
>;

export function getCatalogIntegrationSchemaCompatibilityPolicy(
  key: CatalogIntegrationSchemaCompatibilitySurfaceKey,
): CatalogIntegrationSchemaCompatibilityPolicy {
  return catalogIntegrationSchemaCompatibilityPoliciesByKey[key];
}

export const catalogIntegrationSchemaCompatibilityGovernanceDataClasses = {
  "provider-adapter-contract": ["provider-transport-diagnostic"],
  "provider-payload-provenance-envelope": ["raw-provider-payload", "sampled-provider-payload"],
  "provider-profile-version": ["audit-evidence"],
  "profile-section-command": ["audit-evidence"],
  "executable-mapping-contract": ["fixture-payload", "dry-run-output-evidence"],
  "catalog-integration-engine-io": ["dry-run-input-payload", "dry-run-output-evidence", "engine-diagnostic"],
  "diagnostic-record": ["engine-diagnostic", "provider-transport-diagnostic"],
  "fixture-contract": ["fixture-payload", "sampled-provider-payload"],
  "admin-control-plane-read-model": ["dry-run-output-evidence", "audit-evidence", "job-progress-summary"],
  "source-observation-record": ["raw-provider-payload", "audit-evidence"],
  "integration-durable-job": ["job-progress-summary", "audit-evidence"],
  "integration-work-unit": ["job-progress-summary"],
  "audit-evidence-record": ["audit-evidence"],
} as const satisfies Readonly<
  Record<CatalogIntegrationSchemaCompatibilitySurfaceKey, readonly CatalogIntegrationGovernedDataClassKey[]>
>;
