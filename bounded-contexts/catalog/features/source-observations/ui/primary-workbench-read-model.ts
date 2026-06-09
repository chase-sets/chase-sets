import type { ListResponse } from "@chase-sets/http/responses";
import {
  catalogPrimaryWorkbenchContractVersion,
  catalogPrimaryWorkbenchDeploySkewPolicies,
  catalogPrimaryWorkbenchInstrumentationDimensions,
  validateCatalogPrimaryWorkbenchReadModelContract,
  type CatalogPrimaryWorkbenchActionReadModel,
  type CatalogPrimaryWorkbenchBlockerCategory,
  type CatalogPrimaryWorkbenchProviderTransportCategory,
  type CatalogPrimaryWorkbenchReadModel,
  type CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import { defineCatalogIntegrationUnitKey, type CatalogIntegrationUnitKey } from "../api/integration-unit";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
} from "./contracts";
import {
  catalogPrimaryWorkbenchHref,
  parseCatalogPrimaryWorkbenchRouteContext,
} from "./primary-workbench-route-context";

export type CatalogPrimaryWorkbenchInput = Readonly<{
  requestUrl: string | URL;
  scopes: ListResponse<SourceObservationIntegrationScope>;
  profileReviews: ListResponse<CatalogProviderProfileVersionReview>;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  canManageCatalog: boolean;
}>;

export function buildCatalogPrimaryWorkbenchReadModel(
  input: CatalogPrimaryWorkbenchInput,
): CatalogPrimaryWorkbenchReadModel {
  const parsedContext = parseCatalogPrimaryWorkbenchRouteContext(input.requestUrl);
  const providerKey = parsedContext.providerKey ?? inferProviderKey(input);
  const activeProfile = findActiveProfile(input.profileReviews.items, providerKey);
  const unitKey = parsedContext.unitKey ?? inferUnitKey(input, providerKey, activeProfile);
  const importScope = parsedContext.importScope ?? inferImportScope(input.scopes.items, providerKey);
  const profileVersion = parsedContext.profileVersion ?? activeProfile?.profileVersion ?? null;
  const routeContext: CatalogPrimaryWorkbenchRouteContext = {
    ...parsedContext,
    providerKey,
    unitKey,
    importScope,
    profileVersion,
    sourceObservationFilters: {
      ...parsedContext.sourceObservationFilters,
      ...(providerKey ? { providerKey } : {}),
      ...(importScope ? { importScope } : {}),
    },
  };
  const scopeRows = providerKey
    ? input.scopes.items.filter((scope) => scope.provider_key === providerKey)
    : input.scopes.items;
  const observed = sum(scopeRows, (scope) => scope.observed_observations);
  const changed = sum(scopeRows, (scope) => scope.changed_observations);
  const promoted = sum(scopeRows, (scope) => scope.promoted_observations);
  const rejected = sum(scopeRows, (scope) => scope.rejected_observations);
  const eligible = Math.max(changed - rejected, 0);
  const readinessBlockers = readinessBlockersFor(input, providerKey, activeProfile);
  const canManage = input.canManageCatalog;
  const actions = buildActions({
    canManage,
    providerSelected: Boolean(providerKey && unitKey && importScope),
    activeProfileReady: Boolean(activeProfile),
    eligible,
    blockers: readinessBlockers,
  });

  const readModel: CatalogPrimaryWorkbenchReadModel = {
    schemaVersion: catalogPrimaryWorkbenchContractVersion,
    generatedAt: input.controlPlaneOverview?.generatedAt ?? new Date().toISOString(),
    routeContext,
    providerScope: {
      providers: providerScopeProviders(input, providerKey, activeProfile),
    },
    readiness: {
      freshness: input.controlPlaneOverview ? "fresh" : "partial",
      blockers: readinessBlockers,
      providerTransport: providerTransportFor(input.controlPlaneOverview, providerKey),
      rolloutEnabled:
        input.controlPlaneOverview?.readiness.rolloutControls.controls.every(
          (control) => control.status !== "blocked",
        ) ?? true,
      rbacAllowed: input.canManageCatalog,
      auditEvidenceUrl: catalogPrimaryWorkbenchHref(routeContext, "evidence"),
    },
    importJobs: {
      freshness: input.controlPlaneOverview ? "fresh" : "partial",
      jobs: importJobsFor(input.controlPlaneOverview, unitKey),
    },
    sourceObservationReview: {
      freshness: scopeRows.length > 0 ? "fresh" : "partial",
      counts: {
        observed,
        changed,
        promoted,
        rejected,
        blocked: readinessBlockers.length,
        eligible,
      },
      cursor: null,
      selectedObservationIds: routeContext.selectedObservationIds,
      evidenceSummariesRedacted: true,
      duplicateConflictCount: 0,
      promotionReadyCount: eligible,
    },
    promotionPreview: {
      previewId: routeContext.promotionPreviewId,
      freshness: eligible > 0 ? "fresh" : "partial",
      dispositions: {
        eligible,
        skipped: rejected,
        blocked: readinessBlockers.length,
        conflicting: 0,
        destructive: 0,
        "stale-preview": 0,
        "confirmation-required": eligible > 0 ? 1 : 0,
      },
      commandPlanHash: routeContext.promotionPreviewId ? `preview:${routeContext.promotionPreviewId}` : null,
      confirmationRequired: eligible > 0,
      destructiveCount: 0,
      blockers: eligible > 0 ? [] : ["no-promotion-eligible-observations"],
    },
    promotionResult: null,
    actions,
    deploySkew: catalogPrimaryWorkbenchDeploySkewPolicies[0],
    securityPrivacy: {
      redactionApplied: true,
      governedDataClasses: ["provider payload", "operator identity", "external source URLs"],
      unsafeEvidenceBlocked: false,
      missingSecurityFieldsBlocker: "security-privacy-blocked",
    },
    instrumentation: {
      dimensions: catalogPrimaryWorkbenchInstrumentationDimensions,
      redactionSafe: true,
    },
  };

  validateCatalogPrimaryWorkbenchReadModelContract(readModel);

  return readModel;
}

function inferProviderKey(input: CatalogPrimaryWorkbenchInput): string | null {
  return (
    input.scopes.items[0]?.provider_key ??
    input.profileReviews.items.find((profile) => profile.active)?.providerKey ??
    input.profileReviews.items[0]?.providerKey ??
    null
  );
}

function inferUnitKey(
  input: CatalogPrimaryWorkbenchInput,
  providerKey: string | null,
  activeProfile: CatalogProviderProfileVersionReview | null,
): CatalogIntegrationUnitKey | null {
  const overviewUnit = input.controlPlaneOverview?.readiness.units.find((unit) => unit.providerKey === providerKey);
  if (overviewUnit) {
    return overviewUnit.unitKey;
  }
  if (!providerKey) {
    return null;
  }
  const supportedScope = activeProfile?.supportedScopes[0] ?? "catalog/source-observation";
  const [productDomain = "catalog", productForm = "source-observation"] = supportedScope.split("/");

  return defineCatalogIntegrationUnitKey({
    providerKey,
    productDomain: normalizeUnitSegment(productDomain),
    productForm: normalizeUnitSegment(productForm),
    ingestionPurpose: "import",
  });
}

function inferImportScope(
  scopes: readonly SourceObservationIntegrationScope[],
  providerKey: string | null,
): string | null {
  const scope = scopes.find((candidate) => !providerKey || candidate.provider_key === providerKey) ?? scopes[0];
  if (!scope) {
    return null;
  }

  return [scope.language_code, scope.product_line_id, scope.series_id, scope.expansion_id].filter(Boolean).join(":");
}

function findActiveProfile(
  profiles: readonly CatalogProviderProfileVersionReview[],
  providerKey: string | null,
): CatalogProviderProfileVersionReview | null {
  return (
    profiles.find((profile) => profile.providerKey === providerKey && profile.active) ??
    profiles.find((profile) => profile.active) ??
    null
  );
}

function readinessBlockersFor(
  input: CatalogPrimaryWorkbenchInput,
  providerKey: string | null,
  activeProfile: CatalogProviderProfileVersionReview | null,
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (!input.canManageCatalog) {
    blockers.add("permission-denied");
  }
  if (!activeProfile) {
    blockers.add("missing-active-profile");
  }
  for (const unit of input.controlPlaneOverview?.readiness.units ?? []) {
    if (providerKey && unit.providerKey !== providerKey) {
      continue;
    }
    if (unit.credentialReadiness === "blocked") {
      blockers.add("provider-credential-missing");
    }
    if (unit.transportReadiness === "blocked") {
      blockers.add("provider-transport-degraded");
    }
    if (unit.fixtureValidationStatus === "blocked") {
      blockers.add("missing-fixture-coverage");
    }
  }

  return [...blockers];
}

function providerTransportFor(
  overview: CatalogIntegrationControlPlaneOverview | null,
  providerKey: string | null,
): readonly CatalogPrimaryWorkbenchProviderTransportCategory[] {
  const categories = new Set<CatalogPrimaryWorkbenchProviderTransportCategory>();
  for (const unit of overview?.readiness.units ?? []) {
    if (providerKey && unit.providerKey !== providerKey) {
      continue;
    }
    for (const diagnostic of unit.diagnostics) {
      if (diagnostic.source === "provider-adapter" && diagnostic.severity !== "info") {
        categories.add(diagnostic.retryAfterSeconds ? "throttle" : "degraded-provider");
      }
    }
  }

  return [...categories];
}

function importJobsFor(
  overview: CatalogIntegrationControlPlaneOverview | null,
  unitKey: string | null,
): CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"] {
  const unitActivity = overview?.unitActivity.units.find((unit) => !unitKey || unit.unitKey === unitKey);
  return (unitActivity?.recentJobs ?? []).slice(0, 3).map((job) => ({
    jobId: job.jobId,
    action: job.action === "reapply" ? "start-reapply" : "start-provider-import",
    state: job.phase === "completed" ? "completed" : job.phase === "failed" ? "failed" : "running",
    operatorStatus: job.operatorStatus,
    consistency: {
      schemaVersion: "catalog-integration-durable-job-v1",
      compatibilityPolicy: "integration-durable-job",
      duplicateSubmissionPolicy: "reuse-active-job",
      profileSnapshotPolicy: "snapshotted-at-enqueue",
      retryResumePolicy: "skip-completed-outcomes",
      partialFailurePolicy: "mixed-outcomes",
      workUnitClaimPolicy: "leased-work-units",
    },
    observationLinks: [],
    blockers: [],
  }));
}

function buildActions(input: {
  canManage: boolean;
  providerSelected: boolean;
  activeProfileReady: boolean;
  eligible: number;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
}): readonly CatalogPrimaryWorkbenchActionReadModel[] {
  const manageState = input.canManage ? "available" : "denied";
  const importBlockers = input.canManage
    ? input.providerSelected && input.activeProfileReady
      ? input.blockers
      : ["missing-active-profile" as const]
    : ["permission-denied" as const];
  const promotionBlockers =
    input.eligible > 0
      ? []
      : (["no-promotion-eligible-observations"] as readonly CatalogPrimaryWorkbenchBlockerCategory[]);

  return [
    {
      key: "select-provider-scope",
      state: "available",
      blockers: [],
      copyKey: null,
    },
    {
      key: "start-provider-import",
      state: importBlockers.length > 0 ? "blocked" : manageState,
      blockers: importBlockers,
      copyKey: importBlockers.length > 0 ? "catalog.primary.import.blocked" : null,
    },
    {
      key: "select-source-observations",
      state: "available",
      blockers: [],
      copyKey: null,
    },
    {
      key: "preview-promotion",
      state: promotionBlockers.length > 0 ? "disabled" : manageState,
      blockers: promotionBlockers,
      copyKey: promotionBlockers.length > 0 ? "catalog.primary.review.empty" : null,
    },
    {
      key: "execute-promotion",
      state: promotionBlockers.length > 0 ? "disabled" : manageState,
      blockers: promotionBlockers,
      copyKey: promotionBlockers.length > 0 ? "catalog.primary.promotion.previewRequired" : null,
    },
  ];
}

function providerScopeProviders(
  input: CatalogPrimaryWorkbenchInput,
  selectedProviderKey: string | null,
  selectedProfile: CatalogProviderProfileVersionReview | null,
): CatalogPrimaryWorkbenchReadModel["providerScope"]["providers"] {
  const providerKeys = new Set<string>();
  for (const scope of input.scopes.items) {
    providerKeys.add(scope.provider_key);
  }
  for (const profile of input.profileReviews.items) {
    providerKeys.add(profile.providerKey);
  }
  if (selectedProviderKey) {
    providerKeys.add(selectedProviderKey);
  }

  return [...providerKeys].sort().map((providerKey) => {
    const profile =
      providerKey === selectedProviderKey
        ? selectedProfile
        : findActiveProfile(input.profileReviews.items, providerKey);
    const providerScopes = input.scopes.items.filter((scope) => scope.provider_key === providerKey);
    const unitKey = inferUnitKey(input, providerKey, profile);

    return {
      providerKey,
      displayName: profile?.displayName ?? providerKey,
      units: [
        {
          unitKey:
            unitKey ??
            defineCatalogIntegrationUnitKey({
              providerKey,
              productDomain: "catalog",
              productForm: "source-observation",
              ingestionPurpose: "import",
            }),
          productDomain: profile?.supportedScopes[0]?.split("/")[0] ?? "catalog",
          productForm: profile?.supportedScopes[0]?.split("/")[1] ?? "source-observation",
          importScopes: providerScopes.map((scope) =>
            [scope.language_code, scope.product_line_id, scope.series_id, scope.expansion_id].filter(Boolean).join(":"),
          ),
          activeProfile: profile
            ? {
                schemaVersion: "catalog-provider-profile-version-v1",
                compatibilityPolicy: "provider-profile-version",
                providerKey: profile.providerKey,
                profileKey: profile.profileKey,
                profileVersion: profile.profileVersion,
                lifecycle: profile.lifecycle,
                active: profile.active,
                connectorKind: profile.connectorKind,
                connectorSourceVersion: null,
                sourceMappingFingerprint: null,
              }
            : null,
        },
      ],
    };
  });
}

function normalizeUnitSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "catalog"
  );
}

function sum<T>(items: readonly T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}
