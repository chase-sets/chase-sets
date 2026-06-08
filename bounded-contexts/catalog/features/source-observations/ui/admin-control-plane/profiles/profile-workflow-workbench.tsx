import { t } from "@chase-sets/localization";
import {
  Button,
  DataTable,
  Inline,
  KeyValueList,
  LinkButton,
  OperationalStatusBanner,
  ProgressBar,
  Select,
  Stack,
  Stat,
  StatGrid,
  StatusPill,
  TaskSummary,
  type DataColumn,
  type SelectItem,
} from "@chase-sets/design-system";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogProviderProfileAuthoringModel,
  CatalogProviderProfileDryRunResult,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationJobResult,
  SourceObservationIntegrationJobScope,
  SourceObservationIntegrationProfileSnapshot,
  SourceObservationPromotionScope,
} from "../../contracts";
import { type CatalogIntegrationModuleArea, moduleAreaLabel } from "../registry";

type CatalogIntegrationOperationsSummary = Readonly<{
  scopes: number;
  total: number;
  observed: number;
  changed: number;
  promoted: number;
  rejected: number;
}>;

type CatalogIntegrationOperationsProgress = Readonly<{
  phase: string;
  completed: number;
  total: number;
  currentName: string | null;
  status: string | null;
}>;

type CatalogIntegrationOperationsJob = Readonly<{
  jobId: string;
  action: "import" | "reapply";
  scope: SourceObservationIntegrationJobScope;
  profileSnapshot: SourceObservationIntegrationProfileSnapshot | null;
  status: string;
  operatorStatus: string;
  progress: CatalogIntegrationOperationsProgress;
  result: SourceObservationIntegrationJobResult | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;

export type CatalogIntegrationAreaWorkbenchProps = Readonly<{
  area: CatalogIntegrationModuleArea;
  selectedProfile: CatalogProviderProfileVersionReview | null;
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  operationsSummary: CatalogIntegrationOperationsSummary;
  operationsJobs: readonly CatalogIntegrationOperationsJob[];
  operationsJobsLoading: boolean;
  operationsJobsError: string | null;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  reviewScope: SourceObservationPromotionScope;
  loading: boolean;
  error: string | null;
  canManageCatalog: boolean;
  validationDryRunFlow: string;
  validationDryRunResult: CatalogProviderProfileDryRunResult | null;
  validationDryRunError: string | null;
  validationDryRunning: boolean;
  onValidationDryRunFlowChange: (flow: string) => void;
  onRunValidationDryRun: () => void;
  onEditProfile: (profile: CatalogProviderProfileVersionReview) => void;
  onDryRun: (profile: CatalogProviderProfileVersionReview) => void;
  onCompare: (profile: CatalogProviderProfileVersionReview) => void;
  onMigrationEvidence: (profile: CatalogProviderProfileVersionReview) => void;
  onActivate: (profile: CatalogProviderProfileVersionReview) => void;
  onImport: () => void;
  onReapply: () => void;
  onPromoteMatching: () => void;
  onRollback: (profile: CatalogProviderProfileVersionReview) => void;
  onRetire: (profile: CatalogProviderProfileVersionReview) => void;
}>;

export function CatalogIntegrationAreaWorkbench({
  area,
  selectedProfile,
  authoringModel,
  operationsSummary,
  operationsJobs,
  operationsJobsLoading,
  operationsJobsError,
  controlPlaneOverview,
  reviewScope,
  loading,
  error,
  canManageCatalog,
  validationDryRunFlow,
  validationDryRunResult,
  validationDryRunError,
  validationDryRunning,
  onValidationDryRunFlowChange,
  onRunValidationDryRun,
  onEditProfile,
  onDryRun,
  onCompare,
  onMigrationEvidence,
  onActivate,
  onImport,
  onReapply,
  onPromoteMatching,
  onRollback,
  onRetire,
}: CatalogIntegrationAreaWorkbenchProps) {
  if (area === "health") {
    return null;
  }

  if (!selectedProfile) {
    return (
      <OperationalStatusBanner
        tone="warning"
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.value.workbench", {
          value: String(moduleAreaLabel(area)),
        })}
        description={t(
          "catalog.features.sourceObservations.ui.integrationManagementPage.select.a.provider.profile.version.to.use.this",
        )}
      />
    );
  }

  const readiness = authoringModel?.activationReadiness;

  if (area === "validation") {
    return (
      <CatalogIntegrationValidationWorkbench
        selectedProfile={selectedProfile}
        authoringModel={authoringModel}
        loading={loading}
        error={error}
        dryRunFlow={validationDryRunFlow}
        dryRunResult={validationDryRunResult}
        dryRunError={validationDryRunError}
        dryRunning={validationDryRunning}
        onDryRunFlowChange={onValidationDryRunFlowChange}
        onRunDryRun={onRunValidationDryRun}
        onOpenDryRunDialog={onDryRun}
        onCompare={onCompare}
        onMigrationEvidence={onMigrationEvidence}
        onActivate={onActivate}
        canManageCatalog={canManageCatalog}
      />
    );
  }

  if (area === "operations") {
    return (
      <CatalogIntegrationOperationsWorkbench
        selectedProfile={selectedProfile}
        summary={operationsSummary}
        jobs={operationsJobs}
        jobsLoading={operationsJobsLoading}
        jobsError={operationsJobsError}
        controlPlaneOverview={controlPlaneOverview}
        reviewScope={reviewScope}
        canManageCatalog={canManageCatalog}
        onImport={onImport}
        onReapply={onReapply}
        onPromoteMatching={onPromoteMatching}
        onRollback={() => onRollback(selectedProfile)}
        onRetire={() => onRetire(selectedProfile)}
      />
    );
  }

  const areaItems =
    area === "authoring"
      ? [
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.editable.sections"),
            value: authoringModel ? String(authoringModel.editableSections.length) : "Loading",
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.flows"),
            value: selectedProfile.fixtures.coveredFlows.join(", ") || "None",
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.mapping.output"),
            value: selectedProfile.mappingOutputKind,
          },
        ]
      : [
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.lifecycle"),
            value: selectedProfile.lifecycle,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.count"),
            value: String(selectedProfile.referenceCount),
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.migration.evidence"),
            value: selectedProfile.migrationEvidence ? "Recorded" : "Not recorded",
          },
        ];

  return (
    <Stack gap={3}>
      <TaskSummary
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.value.workbench.2", {
          value: String(moduleAreaLabel(area)),
        })}
        items={areaItems}
      />
      {loading ? (
        <p className="text-sm text-secondary">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.loading.selected.profile.context")}
        </p>
      ) : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Inline gap={2}>
        {area === "authoring" ? (
          <Button
            size="sm"
            leadingIcon="settings"
            disabled={!canManageCatalog}
            onClick={() => onEditProfile(selectedProfile)}
          >
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.edit.selected.profile")}
          </Button>
        ) : null}
        {area === "audit" ? (
          <>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="badgeCheck"
              disabled={!canManageCatalog}
              onClick={() => onMigrationEvidence(selectedProfile)}
            >
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.evidence")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="badgeCheck"
              disabled={!canManageCatalog}
              onClick={() => onActivate(selectedProfile)}
            >
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.activate")}
            </Button>
          </>
        ) : null}
      </Inline>
    </Stack>
  );
}

function CatalogIntegrationOperationsWorkbench({
  selectedProfile,
  summary,
  jobs,
  jobsLoading,
  jobsError,
  controlPlaneOverview,
  reviewScope,
  canManageCatalog,
  onImport,
  onReapply,
  onPromoteMatching,
  onRollback,
  onRetire,
}: Readonly<{
  selectedProfile: CatalogProviderProfileVersionReview;
  summary: CatalogIntegrationOperationsSummary;
  jobs: readonly CatalogIntegrationOperationsJob[];
  jobsLoading: boolean;
  jobsError: string | null;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  reviewScope: SourceObservationPromotionScope;
  canManageCatalog: boolean;
  onImport: () => void;
  onReapply: () => void;
  onPromoteMatching: () => void;
  onRollback: () => void;
  onRetire: () => void;
}>) {
  const profileJobs = jobs.filter(
    (job) =>
      job.scope.provider === selectedProfile.providerKey ||
      job.profileSnapshot?.providerKey === selectedProfile.providerKey,
  );
  const providerReadiness = controlPlaneOverview?.providerReadiness.providers.find(
    (provider) => provider.providerKey === selectedProfile.providerKey,
  );
  const unitKeys = providerReadiness?.unitKeys ?? [];
  const unitActivity =
    controlPlaneOverview?.unitActivity.units.filter(
      (unit) =>
        unitKeys.includes(unit.unitKey) ||
        unit.recentJobs.some((job) => job.providerKey === selectedProfile.providerKey),
    ) ?? [];
  const latestUnitJobs = unitActivity.flatMap((unit) =>
    unit.recentJobs.map((job) => ({
      ...job,
      unitKey: unit.unitKey,
    })),
  );
  const reviewHref = sourceObservationPromotionScopeHref(reviewScope);

  return (
    <Stack gap={4}>
      <TaskSummary
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.operations.workbench")}
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.profile"),
            value: `${selectedProfile.displayName} ${selectedProfile.profileVersion}`,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.ingestion.units"),
            value: unitKeys.length > 0 ? unitKeys.join(", ") : "Not reported",
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.adapter.readiness"),
            value: providerReadiness ? providerReadiness.readiness : "Not reported",
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.count"),
            value: String(selectedProfile.referenceCount),
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.current.review.scope"),
            value: formatPromotionScope(reviewScope),
          },
        ]}
      />

      <ImportJobOperationsWorkflow
        profile={selectedProfile}
        providerReadiness={providerReadiness ?? null}
        jobs={profileJobs}
        latestUnitJobs={latestUnitJobs}
        loading={jobsLoading}
        error={jobsError}
        canManageCatalog={canManageCatalog}
        onImport={onImport}
      />

      <SourceObservationReviewWorkflow summary={summary} reviewHref={reviewHref} />

      <PromotionReapplyWorkflow
        summary={summary}
        reviewScope={reviewScope}
        canManageCatalog={canManageCatalog}
        onPromoteMatching={onPromoteMatching}
        onReapply={onReapply}
      />

      <RollbackRetirementWorkflow
        profile={selectedProfile}
        jobs={profileJobs}
        latestUnitJobs={latestUnitJobs}
        canManageCatalog={canManageCatalog}
        onRollback={onRollback}
        onRetire={onRetire}
      />
    </Stack>
  );
}

function ImportJobOperationsWorkflow({
  profile,
  providerReadiness,
  jobs,
  latestUnitJobs,
  loading,
  error,
  canManageCatalog,
  onImport,
}: Readonly<{
  profile: CatalogProviderProfileVersionReview;
  providerReadiness: CatalogIntegrationControlPlaneOverview["providerReadiness"]["providers"][number] | null;
  jobs: readonly CatalogIntegrationOperationsJob[];
  latestUnitJobs: readonly (CatalogIntegrationControlPlaneOverview["unitActivity"]["units"][number]["recentJobs"][number] & {
    unitKey: string;
  })[];
  loading: boolean;
  error: string | null;
  canManageCatalog: boolean;
  onImport: () => void;
}>) {
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  return (
    <Stack gap={2}>
      <Inline gap={2} align="center">
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.import.and.job.operations")}</h3>
        <StatusPill tone={providerReadiness?.readiness === "ready" ? "success" : "warning"}>
          {providerReadiness?.readiness ?? "unreported"}
        </StatusPill>
      </Inline>
      <KeyValueList
        density="compact"
        variant="plain"
        items={[
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.provider"),
            value: profile.providerKey,
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.transport"),
            value:
              providerReadiness?.payloadAcquisition.message ??
              providerReadiness?.payloadAcquisition.status ??
              "Not reported",
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.credential"),
            value: providerReadiness?.credentialReadiness ?? "Not reported",
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.active.jobs"),
            value: String(activeJobs.length),
          },
        ]}
      />
      <Inline gap={2}>
        <Button size="sm" leadingIcon="plus" disabled={!canManageCatalog} onClick={onImport}>
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.pull.provider.data")}
        </Button>
      </Inline>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-secondary">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.loading.active.jobs")}
        </p>
      ) : null}
      {jobs.length > 0 ? (
        <DataTable
          rows={[...jobs]}
          columns={operationsJobColumns}
          getRowId={(row) => row.jobId}
          emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.active.integration.jobs")}
          density="compact"
        />
      ) : (
        <DataTable
          rows={[...latestUnitJobs]}
          columns={recentUnitJobColumns}
          getRowId={(row) => `${row.unitKey}-${row.createdAt}-${row.action}`}
          emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.active.integration.jobs")}
          density="compact"
        />
      )}
    </Stack>
  );
}

function SourceObservationReviewWorkflow({
  summary,
  reviewHref,
}: Readonly<{ summary: CatalogIntegrationOperationsSummary; reviewHref: string }>) {
  const reviewable = summary.observed + summary.changed;

  return (
    <Stack gap={2}>
      <Inline gap={2} align="center">
        <h3>
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.source.observation.review.workflow")}
        </h3>
        <StatusPill tone={reviewable > 0 ? "warning" : "success"}>
          {reviewable > 0
            ? t("catalog.features.sourceObservations.ui.integrationManagementPage.needs.review")
            : t("catalog.features.sourceObservations.ui.integrationManagementPage.clear")}
        </StatusPill>
      </Inline>
      <StatGrid columns={{ base: 2, md: 4 }}>
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.scopes")}
          value={formatCount(summary.scopes)}
        />
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.observed")}
          value={formatCount(summary.observed)}
        />
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.changed")}
          value={formatCount(summary.changed)}
        />
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.promoted")}
          value={formatCount(summary.promoted)}
        />
      </StatGrid>
      <p className="text-sm text-secondary">
        {t(
          "catalog.features.sourceObservations.ui.integrationManagementPage.review.source.observations.by.provider.unit.profile.scope.status.provenance.facts.condition.certification.evidence.and.diagnostics",
        )}
      </p>
      <Inline gap={2}>
        <LinkButton href={reviewHref} size="sm" tone="secondary">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.review.matching.observations")}
        </LinkButton>
      </Inline>
    </Stack>
  );
}

function PromotionReapplyWorkflow({
  summary,
  reviewScope,
  canManageCatalog,
  onPromoteMatching,
  onReapply,
}: Readonly<{
  summary: CatalogIntegrationOperationsSummary;
  reviewScope: SourceObservationPromotionScope;
  canManageCatalog: boolean;
  onPromoteMatching: () => void;
  onReapply: () => void;
}>) {
  const reviewable = summary.observed + summary.changed;

  return (
    <Stack gap={2}>
      <Inline gap={2} align="center">
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.promote.reapply.workflow")}</h3>
        <StatusPill tone={summary.promoted > 0 ? "info" : "warning"}>
          {summary.promoted > 0
            ? t("catalog.features.sourceObservations.ui.integrationManagementPage.promoted")
            : t("catalog.features.sourceObservations.ui.integrationManagementPage.no.promoted.observations")}
        </StatusPill>
      </Inline>
      <KeyValueList
        density="compact"
        variant="plain"
        items={[
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.command.scope"),
            value: formatPromotionScope(reviewScope),
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.promotion.evidence"),
            value: t(
              "catalog.features.sourceObservations.ui.integrationManagementPage.engine.generated.command.plans.remain.scoped.to.the.selected.catalog.ingestion.unit",
            ),
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.reapply.guardrail"),
            value: t(
              "catalog.features.sourceObservations.ui.integrationManagementPage.reapply.uses.the.active.profile.mapping.without.changing.provider.transport.behavior",
            ),
          },
        ]}
      />
      <Inline gap={2}>
        <Button
          size="sm"
          leadingIcon="badgeCheck"
          disabled={!canManageCatalog || reviewable === 0}
          onClick={onPromoteMatching}
        >
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.promote.matching")}
        </Button>
        <Button
          size="sm"
          tone="secondary"
          leadingIcon="refreshCcw"
          disabled={!canManageCatalog || summary.promoted === 0}
          onClick={onReapply}
        >
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.reapply.promoted")}
        </Button>
      </Inline>
    </Stack>
  );
}

function RollbackRetirementWorkflow({
  profile,
  jobs,
  latestUnitJobs,
  canManageCatalog,
  onRollback,
  onRetire,
}: Readonly<{
  profile: CatalogProviderProfileVersionReview;
  jobs: readonly CatalogIntegrationOperationsJob[];
  latestUnitJobs: readonly (CatalogIntegrationControlPlaneOverview["unitActivity"]["units"][number]["recentJobs"][number] & {
    unitKey: string;
  })[];
  canManageCatalog: boolean;
  onRollback: () => void;
  onRetire: () => void;
}>) {
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running").length;
  const latestJobCount = latestUnitJobs.length;
  const retireBlocked = profile.referenceCount > 0;

  return (
    <Stack gap={2}>
      <Inline gap={2} align="center">
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.rollback.retirement.workflow")}</h3>
        <StatusPill tone={retireBlocked ? "warning" : "success"}>
          {retireBlocked
            ? t("catalog.features.sourceObservations.ui.integrationManagementPage.references.remain")
            : t("catalog.features.sourceObservations.ui.integrationManagementPage.ready")}
        </StatusPill>
      </Inline>
      <KeyValueList
        density="compact"
        variant="plain"
        items={[
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.affected.references"),
            value: String(profile.referenceCount),
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.affected.jobs"),
            value: String(activeJobs || latestJobCount),
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.rollback.implication"),
            value: t(
              "catalog.features.sourceObservations.ui.integrationManagementPage.rollback.reactivates.a.previous.profile.version.and.keeps.observation.replay.explicit",
            ),
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.retirement.gate"),
            value: retireBlocked
              ? t(
                  "catalog.features.sourceObservations.ui.integrationManagementPage.blocked.until.source.observation.references.are.migrated.or.archived",
                )
              : t(
                  "catalog.features.sourceObservations.ui.integrationManagementPage.no.source.observation.references.remain",
                ),
          },
        ]}
      />
      <Inline gap={2}>
        <Button size="sm" tone="secondary" leadingIcon="refreshCcw" disabled={!canManageCatalog} onClick={onRollback}>
          {t("catalog.features.sourceObservations.ui.integrations.profile.review.rollback")}
        </Button>
        <Button
          size="sm"
          tone="danger"
          leadingIcon="trash"
          disabled={!canManageCatalog || retireBlocked}
          onClick={onRetire}
        >
          {t("catalog.features.sourceObservations.ui.integrations.profile.review.retire")}
        </Button>
      </Inline>
    </Stack>
  );
}

const operationsJobColumns: DataColumn<CatalogIntegrationOperationsJob>[] = [
  {
    key: "job",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.job"),
    cell: (row) => (
      <Stack gap={1}>
        <Inline gap={2}>
          <StatusPill tone={jobStatusTone(row.status)}>{row.operatorStatus}</StatusPill>
          <span>{row.action}</span>
        </Inline>
        <span className="text-xs text-secondary">{row.jobId}</span>
      </Stack>
    ),
  },
  {
    key: "profile",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.snapshot"),
    cell: (row) =>
      row.profileSnapshot ? (
        <Stack gap={1}>
          <span>
            {row.profileSnapshot.providerKey} {row.profileSnapshot.profileVersion}
          </span>
          <span className="text-xs text-secondary">
            {row.profileSnapshot.profileKey} - {row.profileSnapshot.lifecycle}
          </span>
        </Stack>
      ) : (
        t("catalog.features.sourceObservations.ui.integrationManagementPage.no.snapshot")
      ),
  },
  {
    key: "scope",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.scope"),
    cell: (row) => formatIntegrationJobScope(row.scope),
  },
  {
    key: "progress",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.progress"),
    cell: (row) => (
      <ProgressBar
        value={progressPercent(row.progress)}
        tone={row.status === "failed" ? "danger" : row.status === "completed" ? "success" : "active"}
        formatLabel={() => formatProgress(row.progress)}
      />
    ),
  },
];

const recentUnitJobColumns: DataColumn<
  CatalogIntegrationControlPlaneOverview["unitActivity"]["units"][number]["recentJobs"][number] & { unitKey: string }
>[] = [
  {
    key: "job",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.job"),
    cell: (row) => (
      <Stack gap={1}>
        <Inline gap={2}>
          <StatusPill tone={jobStatusTone(row.operatorStatus)}>{row.operatorStatus}</StatusPill>
          <span>{row.action}</span>
        </Inline>
        <span className="text-xs text-secondary">{row.jobId}</span>
      </Stack>
    ),
  },
  {
    key: "unit",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.unit"),
    cell: (row) => row.unitKey,
  },
  {
    key: "profile",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.profile"),
    cell: (row) => (
      <Stack gap={1}>
        <span>
          {row.providerKey} {row.profileVersion ?? "No profile"}
        </span>
        <span className="text-xs text-secondary">{row.summary}</span>
      </Stack>
    ),
  },
  {
    key: "progress",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.progress"),
    cell: (row) => `${row.completed}/${row.total} ${row.phase}`,
  },
];

function jobStatusTone(status: string): "success" | "danger" | "info" | "warning" {
  if (status === "completed") {
    return "success";
  }

  if (status === "failed") {
    return "danger";
  }

  if (status === "stale" || status === "partial" || status === "retried") {
    return "warning";
  }

  return "info";
}

function progressPercent(progress: CatalogIntegrationOperationsProgress): number {
  if (progress.phase === "completed") {
    return 100;
  }

  if (progress.total <= 0) {
    return 0;
  }

  return (progress.completed / progress.total) * 100;
}

function formatProgress(progress: CatalogIntegrationOperationsProgress): string {
  if (progress.phase === "queued") {
    return t("catalog.features.sourceObservations.ui.list.bulk.progress.queued");
  }

  if (progress.total <= 0) {
    return t("catalog.features.sourceObservations.ui.list.bulk.progress.preparing");
  }

  if (progress.phase === "completed") {
    return t("catalog.features.sourceObservations.ui.list.bulk.progress.completed", {
      completed: String(progress.completed),
      total: String(progress.total),
    });
  }

  return t("catalog.features.sourceObservations.ui.list.bulk.progress.processing", {
    completed: String(progress.completed),
    total: String(progress.total),
  });
}

function sourceObservationPromotionScopeHref(scope: SourceObservationPromotionScope) {
  const params = new URLSearchParams();

  if (scope.provider) {
    params.set("source", scope.provider);
  }

  if (scope.language) {
    params.set("language", scope.language);
  }

  if (scope.setId) {
    params.set("setId", scope.setId);
  }

  const query = params.toString();
  return query ? `/catalog/source-observations?${query}` : "/catalog/source-observations";
}

function formatPromotionScope(scope: SourceObservationPromotionScope): string {
  const parts = [
    scope.search
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.search", {
          search: scope.search,
        })
      : "",
    scope.language
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.language", {
          language: scope.language,
        })
      : "",
    scope.provider
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.provider", {
          provider: scope.provider,
        })
      : "",
    scope.setId
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.expansion", {
          setId: scope.setId,
        })
      : "",
  ].filter(Boolean);

  return parts.length > 0
    ? parts.join(", ")
    : t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.all");
}

function formatIntegrationJobScope(scope: SourceObservationIntegrationJobScope): string {
  const parts = Object.entries(scope)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([key, value]) => `${key}: ${value}`);

  return parts.length > 0
    ? parts.join(", ")
    : t("catalog.features.sourceObservations.ui.integrationManagementPage.all.provider.scopes");
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function CatalogIntegrationValidationWorkbench({
  selectedProfile,
  authoringModel,
  loading,
  error,
  dryRunFlow,
  dryRunResult,
  dryRunError,
  dryRunning,
  onDryRunFlowChange,
  onRunDryRun,
  onOpenDryRunDialog,
  onCompare,
  onMigrationEvidence,
  onActivate,
  canManageCatalog,
}: Readonly<{
  selectedProfile: CatalogProviderProfileVersionReview;
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  loading: boolean;
  error: string | null;
  dryRunFlow: string;
  dryRunResult: CatalogProviderProfileDryRunResult | null;
  dryRunError: string | null;
  dryRunning: boolean;
  onDryRunFlowChange: (flow: string) => void;
  onRunDryRun: () => void;
  onOpenDryRunDialog: (profile: CatalogProviderProfileVersionReview) => void;
  onCompare: (profile: CatalogProviderProfileVersionReview) => void;
  onMigrationEvidence: (profile: CatalogProviderProfileVersionReview) => void;
  onActivate: (profile: CatalogProviderProfileVersionReview) => void;
  canManageCatalog: boolean;
}>) {
  if (loading) {
    return (
      <OperationalStatusBanner
        tone="info"
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.loading.validation.workbench")}
        description={t(
          "catalog.features.sourceObservations.ui.integrationManagementPage.loading.selected.profile.context",
        )}
      />
    );
  }

  if (error) {
    return (
      <OperationalStatusBanner
        tone="danger"
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.validation.workbench.unavailable")}
        description={error}
      />
    );
  }

  if (!authoringModel) {
    return (
      <OperationalStatusBanner
        tone="warning"
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.validation.workbench.unavailable")}
        description={t(
          "catalog.features.sourceObservations.ui.integrationManagementPage.selected.profile.context.not.loaded",
        )}
      />
    );
  }

  const readiness = authoringModel.activationReadiness;
  const blockedChecks = readiness.checks.filter((check) => check.status === "blocked");
  const changedDiffs = authoringModel.semanticDiff.changes.filter((change) => change.changed);
  const fixtureItems = dryRunFixtureItems(authoringModel);
  const selectedFixture = authoringModel.fixtureCases.find((fixtureCase) => fixtureCase.flow === dryRunFlow) ?? null;

  return (
    <Stack gap={4}>
      <TaskSummary
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.validation.workbench")}
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.profile"),
            value: `${selectedProfile.displayName} ${selectedProfile.profileVersion}`,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.validation"),
            value: selectedProfile.validation.status,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.readiness"),
            value: readiness.status,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.blocking.checks"),
            value: String(blockedChecks.length),
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.semantic.changes"),
            value: String(changedDiffs.length),
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.flows"),
            value: `${authoringModel.fixtureCases.filter((fixtureCase) => fixtureCase.samplePayloadAvailable).length}/${authoringModel.fixtureCases.length}`,
          },
        ]}
      />

      <FixtureValidationWorkflow model={authoringModel} />

      <DryRunEvidenceWorkflow
        model={authoringModel}
        selectedFixture={selectedFixture}
        dryRunFlow={dryRunFlow}
        dryRunItems={fixtureItems}
        dryRunResult={dryRunResult}
        dryRunError={dryRunError}
        dryRunning={dryRunning}
        onDryRunFlowChange={onDryRunFlowChange}
        onRunDryRun={onRunDryRun}
        onOpenDryRunDialog={() => onOpenDryRunDialog(selectedProfile)}
      />

      <SemanticComparisonWorkflow model={authoringModel} onCompare={() => onCompare(selectedProfile)} />

      <ActivationReadinessWorkflow
        profile={selectedProfile}
        model={authoringModel}
        canManageCatalog={canManageCatalog}
        onMigrationEvidence={() => onMigrationEvidence(selectedProfile)}
        onActivate={() => onActivate(selectedProfile)}
      />
    </Stack>
  );
}

function FixtureValidationWorkflow({ model }: Readonly<{ model: CatalogProviderProfileAuthoringModel }>) {
  return (
    <Stack gap={2}>
      <Inline gap={2} align="center">
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.validation.workflow")}</h3>
        <StatusPill tone={fixtureWorkflowTone(model)}>{fixtureWorkflowLabel(model)}</StatusPill>
      </Inline>
      <DataTable
        rows={model.fixtureCases}
        columns={fixtureValidationColumns(model)}
        getRowId={(row) => row.flow}
        emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.fixture.cases")}
        density="compact"
      />
      <DataTable
        rows={model.sectionSummaries.filter(
          (section) => section.diagnostics.length > 0 || section.readinessChecks.length > 0,
        )}
        columns={sectionValidationColumns}
        getRowId={(row) => row.sectionKey}
        emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.section.diagnostics")}
        density="compact"
      />
    </Stack>
  );
}

function DryRunEvidenceWorkflow({
  model,
  selectedFixture,
  dryRunFlow,
  dryRunItems,
  dryRunResult,
  dryRunError,
  dryRunning,
  onDryRunFlowChange,
  onRunDryRun,
  onOpenDryRunDialog,
}: Readonly<{
  model: CatalogProviderProfileAuthoringModel;
  selectedFixture: CatalogProviderProfileAuthoringModel["fixtureCases"][number] | null;
  dryRunFlow: string;
  dryRunItems: readonly SelectItem[];
  dryRunResult: CatalogProviderProfileDryRunResult | null;
  dryRunError: string | null;
  dryRunning: boolean;
  onDryRunFlowChange: (flow: string) => void;
  onRunDryRun: () => void;
  onOpenDryRunDialog: () => void;
}>) {
  return (
    <Stack gap={2}>
      <Inline gap={2} align="center">
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.dry.run.evidence.workflow")}</h3>
        <StatusPill tone={selectedFixture?.samplePayloadAvailable ? "success" : "warning"}>
          {selectedFixture?.samplePayloadAvailable
            ? t("catalog.features.sourceObservations.ui.integrationManagementPage.sample.available")
            : t("catalog.features.sourceObservations.ui.integrationManagementPage.sample.missing")}
        </StatusPill>
      </Inline>
      <Inline gap={2} align="end">
        <Select
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.flow")}
          value={dryRunFlow}
          onValueChange={onDryRunFlowChange}
          items={[...dryRunItems]}
        />
        <Button
          size="sm"
          leadingIcon="play"
          loading={dryRunning}
          disabled={!selectedFixture?.samplePayloadAvailable}
          onClick={onRunDryRun}
        >
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.run.selected.fixture")}
        </Button>
        <Button size="sm" tone="secondary" leadingIcon="settings" onClick={onOpenDryRunDialog}>
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.open.override.dry.run")}
        </Button>
      </Inline>
      <KeyValueList
        density="compact"
        variant="plain"
        items={[
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.default.flow"),
            value: model.dryRunInputTemplate.defaultFlow ?? "None",
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.payload"),
            value: selectedFixture?.payloadFile ?? "None",
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.expected.status"),
            value: selectedFixture?.expectedStatus ?? "None",
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.expected.observation"),
            value: summarizeJsonValue(selectedFixture?.expectedObservation ?? null),
          },
        ]}
      />
      {dryRunError ? (
        <OperationalStatusBanner
          tone="danger"
          title={t("catalog.features.sourceObservations.ui.integrationManagementPage.dry.run.failed")}
          description={dryRunError}
        />
      ) : null}
      {dryRunResult ? <DryRunResultEvidence result={dryRunResult} /> : null}
    </Stack>
  );
}

function DryRunResultEvidence({ result }: Readonly<{ result: CatalogProviderProfileDryRunResult }>) {
  return (
    <Stack gap={3}>
      <TaskSummary
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.dry.run.output.evidence")}
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.status"),
            value: result.status,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.source.observation.facts"),
            value: result.observation ? sourceObservationFactSummary(result) : "None",
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.diagnostics"),
            value: String(result.diagnostics.length),
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.duplicate.candidates"),
            value: duplicateCandidateSummary(result),
          },
          {
            label: t(
              "catalog.features.sourceObservations.ui.integrationManagementPage.condition.certification.evidence",
            ),
            value: summarizeJsonValue(result.selectedOptions),
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.promotion.plan.evidence"),
            value: `${result.promotionCommandPlan.commands.length} command(s)`,
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.audit.evidence"),
            value: `${result.hashMaterial.length + result.mergeCandidateEvidence.length} evidence path(s)`,
          },
        ]}
      />
      <DataTable
        rows={result.diagnosticLinks}
        columns={dryRunDiagnosticLinkColumns}
        getRowId={(row, index) => `${row.path}:${index}`}
        emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.diagnostic.links")}
        density="compact"
      />
      <DataTable
        rows={result.promotionCommandPlan.commands}
        columns={promotionPlanEvidenceColumns}
        getRowId={(row, index) => `${row.commandName}:${index}`}
        emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.promotion.commands")}
        density="compact"
      />
    </Stack>
  );
}

function SemanticComparisonWorkflow({
  model,
  onCompare,
}: Readonly<{ model: CatalogProviderProfileAuthoringModel; onCompare: () => void }>) {
  const changedDiffs = model.semanticDiff.changes.filter((change) => change.changed);
  return (
    <Stack gap={2}>
      <Inline gap={2} align="center">
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.semantic.comparison.workflow")}</h3>
        <StatusPill tone={model.semanticDiff.mappingFingerprint.changed ? "warning" : "success"}>
          {model.semanticDiff.mappingFingerprint.changed
            ? t("catalog.features.sourceObservations.ui.integrationManagementPage.mapping.changed")
            : t("catalog.features.sourceObservations.ui.integrationManagementPage.mapping.unchanged")}
        </StatusPill>
        <Button size="sm" tone="secondary" leadingIcon="search" onClick={onCompare}>
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.compare.active")}
        </Button>
      </Inline>
      <KeyValueList
        density="compact"
        variant="plain"
        items={[
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.candidate"),
            value: model.semanticDiff.candidateProfileVersion,
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.active"),
            value: model.semanticDiff.activeProfileVersion ?? "None",
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.candidate.fingerprint"),
            value: model.semanticDiff.mappingFingerprint.candidate ?? "None",
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.active.fingerprint"),
            value: model.semanticDiff.mappingFingerprint.active ?? "None",
          },
        ]}
      />
      <DataTable
        rows={model.semanticDiff.sections}
        columns={semanticSectionColumns}
        getRowId={(row) => row.sectionKey}
        emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.semantic.sections")}
        density="compact"
      />
      <DataTable
        rows={changedDiffs.length > 0 ? changedDiffs : model.semanticDiff.changes}
        columns={semanticChangeColumns}
        getRowId={(row) => row.path}
        emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.semantic.changes")}
        density="compact"
      />
    </Stack>
  );
}

function ActivationReadinessWorkflow({
  profile,
  model,
  canManageCatalog,
  onMigrationEvidence,
  onActivate,
}: Readonly<{
  profile: CatalogProviderProfileVersionReview;
  model: CatalogProviderProfileAuthoringModel;
  canManageCatalog: boolean;
  onMigrationEvidence: () => void;
  onActivate: () => void;
}>) {
  const readiness = model.activationReadiness;
  const blockedChecks = readiness.checks.filter((check) => check.status === "blocked");
  return (
    <Stack gap={2}>
      <Inline gap={2} align="center">
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.activation.readiness.workflow")}</h3>
        <StatusPill tone={readiness.status === "ready" ? "success" : "danger"}>
          {readiness.status === "ready"
            ? t("catalog.features.sourceObservations.ui.integrationManagementPage.ready.to.activate")
            : t("catalog.features.sourceObservations.ui.integrationManagementPage.activation.blocked")}
        </StatusPill>
        <Button
          size="sm"
          tone="secondary"
          leadingIcon="badgeCheck"
          disabled={!canManageCatalog}
          onClick={onMigrationEvidence}
        >
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.evidence")}
        </Button>
        <Button
          size="sm"
          leadingIcon="badgeCheck"
          disabled={!canManageCatalog || readiness.status !== "ready"}
          onClick={onActivate}
        >
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.activate")}
        </Button>
      </Inline>
      <KeyValueList
        density="compact"
        variant="plain"
        items={[
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.affected.references"),
            value: String(readiness.referenceCount),
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.migration.evidence"),
            value: readiness.requiresMigrationEvidence
              ? t("catalog.features.sourceObservations.ui.integrationManagementPage.required")
              : t("catalog.features.sourceObservations.ui.integrationManagementPage.not.required"),
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.replay.implication"),
            value: replayImplication(profile),
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.compatibility.mode"),
            value: profile.compatibilityMode,
          },
          {
            key: t("catalog.features.sourceObservations.ui.integrationManagementPage.blocking.checks"),
            value: String(blockedChecks.length),
          },
        ]}
      />
      <DataTable
        rows={readiness.groups}
        columns={readinessGroupColumns}
        getRowId={(row) => row.domainConcept}
        emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.readiness.groups")}
        density="compact"
      />
      <DataTable
        rows={blockedChecks.length > 0 ? blockedChecks : readiness.checks}
        columns={activationCheckColumns}
        getRowId={(row, index) => `${row.checkKey}:${row.path}:${index}`}
        emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.readiness.checks")}
        density="compact"
      />
    </Stack>
  );
}

function dryRunFixtureItems(model: CatalogProviderProfileAuthoringModel): SelectItem[] {
  return model.fixtureCases.map((fixtureCase) => ({
    value: fixtureCase.flow,
    label: `${fixtureCase.flow}${fixtureCase.samplePayloadAvailable ? "" : ` (${t("catalog.features.sourceObservations.ui.integrationManagementPage.missing.sample")})`}`,
    disabled: !fixtureCase.samplePayloadAvailable,
  }));
}

function fixtureValidationColumns(
  model: CatalogProviderProfileAuthoringModel,
): DataColumn<CatalogProviderProfileAuthoringModel["fixtureCases"][number]>[] {
  return [
    {
      key: "flow",
      header: t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.flow.2"),
      cell: (row) => row.flow,
    },
    {
      key: "status",
      header: t("catalog.features.sourceObservations.ui.integrationManagementPage.status"),
      cell: (row) => {
        const blocked = model.activationReadiness.checks.some(
          (check) => check.status === "blocked" && check.flow === row.flow,
        );
        return (
          <StatusPill tone={blocked || row.expectedStatus === "blocked" ? "danger" : "success"}>
            {blocked || row.expectedStatus === "blocked"
              ? t("catalog.features.sourceObservations.ui.integrationManagementPage.blocked")
              : t("catalog.features.sourceObservations.ui.integrationManagementPage.ready")}
          </StatusPill>
        );
      },
    },
    {
      key: "sample",
      header: t("catalog.features.sourceObservations.ui.integrationManagementPage.sample"),
      cell: (row) =>
        row.samplePayloadAvailable
          ? t("catalog.features.sourceObservations.ui.integrationManagementPage.available")
          : t("catalog.features.sourceObservations.ui.integrationManagementPage.missing"),
    },
    {
      key: "expected",
      header: t("catalog.features.sourceObservations.ui.integrationManagementPage.expected.evidence"),
      cell: (row) =>
        `${row.expectedHashEvidencePaths.length} hash; ${row.expectedMergeEvidencePaths.length} merge; ${row.expectedPromotionCommands.length} command`,
    },
    {
      key: "observation",
      header: t("catalog.features.sourceObservations.ui.integrationManagementPage.expected.observation"),
      cell: (row) => summarizeJsonValue(row.expectedObservation),
    },
  ];
}

const sectionValidationColumns: DataColumn<CatalogProviderProfileAuthoringModel["sectionSummaries"][number]>[] = [
  {
    key: "section",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.section"),
    cell: (row) => row.domainConcept,
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.status"),
    cell: (row) => <StatusPill tone={sectionStatusTone(row.status)}>{row.status}</StatusPill>,
  },
  {
    key: "diagnostics",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.diagnostics"),
    cell: (row) => String(row.diagnostics.length),
  },
  {
    key: "readiness",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.readiness.checks"),
    cell: (row) => String(row.readinessChecks.length),
  },
  {
    key: "path",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.path"),
    cell: (row) => row.readinessChecks[0]?.path ?? row.diagnostics[0]?.path ?? "None",
  },
];

const dryRunDiagnosticLinkColumns: DataColumn<CatalogProviderProfileDryRunResult["diagnosticLinks"][number]>[] = [
  {
    key: "flow",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.flow.2"),
    cell: (row) => row.fixtureFlow ?? "None",
  },
  {
    key: "section",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.section"),
    cell: (row) => row.domainConcept,
  },
  {
    key: "code",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.code"),
    cell: (row) => row.code,
  },
  {
    key: "path",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.path"),
    cell: (row) => row.path,
  },
];

const promotionPlanEvidenceColumns: DataColumn<
  CatalogProviderProfileDryRunResult["promotionCommandPlan"]["commands"][number]
>[] = [
  {
    key: "command",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.command"),
    cell: (row) => row.commandName,
  },
  {
    key: "inputs",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.evidence.paths"),
    cell: (row) => String(row.inputs.length),
  },
  {
    key: "first",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.first.path"),
    cell: (row) => row.inputs[0]?.path ?? "None",
  },
];

const semanticSectionColumns: DataColumn<CatalogProviderProfileAuthoringModel["semanticDiff"]["sections"][number]>[] = [
  {
    key: "section",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.section"),
    cell: (row) => row.domainConcept,
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.status"),
    cell: (row) => <StatusPill tone={sectionStatusTone(row.status)}>{row.status}</StatusPill>,
  },
  {
    key: "changes",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.changes"),
    cell: (row) => String(row.changes.filter((change) => change.changed).length),
  },
];

const semanticChangeColumns: DataColumn<CatalogProviderProfileAuthoringModel["semanticDiff"]["changes"][number]>[] = [
  {
    key: "change",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.change"),
    cell: (row) => (
      <Stack gap={1}>
        <span>{row.label}</span>
        <Inline gap={1}>
          <StatusPill tone={row.changed ? "warning" : "success"}>
            {row.changed
              ? t("catalog.features.sourceObservations.ui.integrationManagementPage.changed")
              : t("catalog.features.sourceObservations.ui.integrationManagementPage.unchanged")}
          </StatusPill>
          <StatusPill tone={semanticSeverityTone(row.severity)}>{row.severity}</StatusPill>
        </Inline>
      </Stack>
    ),
  },
  {
    key: "section",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.section"),
    cell: (row) => row.domainConcept,
  },
  {
    key: "impact",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.activation.impact"),
    cell: (row) => row.activationImpact,
  },
];

const readinessGroupColumns: DataColumn<
  CatalogProviderProfileAuthoringModel["activationReadiness"]["groups"][number]
>[] = [
  {
    key: "group",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.section"),
    cell: (row) => row.domainConcept,
  },
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.status"),
    cell: (row) => <StatusPill tone={row.status === "ready" ? "success" : "danger"}>{row.status}</StatusPill>,
  },
  {
    key: "checks",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.readiness.checks"),
    cell: (row) => String(row.checks.length),
  },
];

const activationCheckColumns: DataColumn<
  CatalogProviderProfileAuthoringModel["activationReadiness"]["checks"][number]
>[] = [
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.status"),
    cell: (row) => (
      <StatusPill tone={row.status === "passed" ? "success" : "danger"}>
        {row.status === "passed"
          ? t("catalog.features.sourceObservations.ui.integrationManagementPage.passed")
          : t("catalog.features.sourceObservations.ui.integrationManagementPage.blocked")}
      </StatusPill>
    ),
  },
  {
    key: "section",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.section"),
    cell: (row) => row.domainConcept,
  },
  {
    key: "path",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.path"),
    cell: (row) => row.path,
  },
  {
    key: "remediation",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.remediation"),
    cell: (row) => row.remediation || row.diagnosticText,
  },
];

function fixtureWorkflowTone(model: CatalogProviderProfileAuthoringModel): "success" | "danger" {
  return model.activationReadiness.checks.some(
    (check) => check.status === "blocked" && check.checkKey.startsWith("fixture-"),
  )
    ? "danger"
    : "success";
}

function fixtureWorkflowLabel(model: CatalogProviderProfileAuthoringModel): string {
  return fixtureWorkflowTone(model) === "success"
    ? t("catalog.features.sourceObservations.ui.integrationManagementPage.ready")
    : t("catalog.features.sourceObservations.ui.integrationManagementPage.blocked");
}

function sectionStatusTone(status: "valid" | "warning" | "error" | "blocked"): "success" | "warning" | "danger" {
  if (status === "valid") {
    return "success";
  }
  return status === "warning" ? "warning" : "danger";
}

function semanticSeverityTone(severity: "info" | "warning" | "error"): "neutral" | "warning" | "danger" {
  if (severity === "error") {
    return "danger";
  }
  return severity === "warning" ? "warning" : "neutral";
}

function sourceObservationFactSummary(result: CatalogProviderProfileDryRunResult): string {
  const normalized = result.observation?.normalized;
  if (!normalized) {
    return "None";
  }
  return `${normalized.kind}; ${result.observation?.externalKey ?? "No external key"}`;
}

function duplicateCandidateSummary(result: CatalogProviderProfileDryRunResult): string {
  const preview = result.duplicatePreventionCandidatePreview;
  if (!preview) {
    return t("catalog.features.sourceObservations.ui.integrationManagementPage.not.evaluated");
  }
  return `${preview.status}; ${preview.candidateCount} candidate(s)`;
}

function replayImplication(profile: CatalogProviderProfileVersionReview): string {
  const contract = isRecord(profile.executableMappingContract) ? profile.executableMappingContract : null;
  const duplicatePrevention = isRecord(contract?.duplicatePrevention) ? contract.duplicatePrevention : null;
  const replayPolicy = typeof duplicatePrevention?.replayPolicy === "string" ? duplicatePrevention.replayPolicy : "";
  if (!replayPolicy) {
    return t("catalog.features.sourceObservations.ui.integrationManagementPage.replay.policy.not.configured");
  }
  return t("catalog.features.sourceObservations.ui.integrationManagementPage.replay.uses.policy", {
    policy: replayPolicy,
  });
}

function summarizeJsonValue(value: unknown): string {
  if (value === null || typeof value === "undefined") {
    return "None";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} item(s)`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    return keys.length > 0 ? keys.slice(0, 3).join(", ") : "Empty object";
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
