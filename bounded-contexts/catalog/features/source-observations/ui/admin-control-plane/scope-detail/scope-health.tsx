import {
  Badge,
  KeyValueList,
  LinkText,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { catalogScopeRecordIdFromPath } from "../../../api/admin/scope-detail-workbench-location";
import { CatalogIntegrationCommandActionProvider } from "../import-to-promotion/command-action-context";
import { stateLabel } from "../import-to-promotion/workbench-formatting";
import { ImportJobLifecycleActions } from "../import-jobs/import-job-lifecycle-actions";
import { catalogProviderDetailHref } from "../provider-detail/provider-detail-links";
import { HealthSourceProvenance } from "../validation/health-source-provenance";
import { IntegrationUnitHealth } from "../validation/integration-unit-health";

export function ScopeHealth({
  readModel,
  scopeRecordId,
  requestUrl,
  actionHref,
  loading,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  scopeRecordId: string;
  requestUrl: string;
  actionHref: string;
  loading: boolean;
}>) {
  const verified =
    readModel.routeContext.scopeRecordId === scopeRecordId &&
    catalogScopeRecordIdFromPath(new URL(requestUrl).pathname) === scopeRecordId;
  const members =
    verified && readModel.sourceScopeWorkset.selectedScope.hasConcreteScope ? readModel.sourceScopeWorkset.units : [];
  const unitKeys = new Set<string>(members.flatMap((unit) => (unit.unitKey ? [unit.unitKey] : [])));
  const units = readModel.healthTriage.units.filter((unit) => unitKeys.has(unit.unitKey));
  const jobs = verified
    ? readModel.healthTriage.recentJobs.filter(
        (job) =>
          job.unitKey &&
          unitKeys.has(job.unitKey) &&
          readModel.importJobs.jobs.some(
            (row) =>
              row.jobId === job.jobId &&
              members.some(
                (unit) =>
                  unit.unitKey === row.unitKey &&
                  unit.providerKey === row.providerKey &&
                  unit.importScope !== null &&
                  unit.importScope === row.importScope,
              ),
          ),
      )
    : [];
  const missingSelection = Boolean(
    (readModel.routeContext.unitKey && !units.some((unit) => unit.unitKey === readModel.routeContext.unitKey)) ||
    (readModel.routeContext.jobId && !jobs.some((job) => job.jobId === readModel.routeContext.jobId)),
  );

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.healthFacts.scopeTitle")}
      status={
        <Badge tone="neutral">
          {stateLabel(loading ? "loading" : units.length ? readModel.healthTriage.status : "unavailable")}
        </Badge>
      }
      density="compact"
    >
      <WorkbenchStack data-catalog-scope-health="true">
        {units.map((unit) => (
          <WorkbenchStack key={unit.unitKey}>
            <IntegrationUnitHealth unit={unit} />
            <LinkText href={catalogProviderDetailHref(unit.providerKey, { unitKey: unit.unitKey })}>
              {t("catalog.features.sourceObservations.ui.healthFacts.providerSetup", { provider: unit.providerKey })}
            </LinkText>
          </WorkbenchStack>
        ))}
        {units.length === 0 || missingSelection ? (
          <WorkbenchText>{t("catalog.features.attentionQueue.resolution.unavailable")}</WorkbenchText>
        ) : null}
        {verified ? (
          <HealthSourceProvenance
            health={readModel.healthTriage}
            queryKeys={["integration-health-summary", "import-job-progress-summary"]}
          />
        ) : null}
        {jobs.map((job) => {
          const retained = readModel.importJobs.jobs.find((row) => row.jobId === job.jobId);
          return (
            <WorkbenchStack key={job.jobId}>
              <KeyValueList
                density="compact"
                items={[
                  { key: job.jobId, value: `${job.providerKey} / ${job.unitKey}` },
                  {
                    key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.status"),
                    value: `${job.operatorStatus} / ${job.phase}`,
                  },
                  { key: t("catalog.features.sourceObservations.ui.healthFacts.progress"), value: job.progressLabel },
                  { key: t("catalog.features.sourceObservations.ui.auditEvidence.table.summary"), value: job.summary },
                  {
                    key: t("catalog.features.sourceObservations.ui.governanceControls.table.metric"),
                    value: job.ownerMetricKey,
                  },
                  {
                    key: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.table.next.action"),
                    value: job.nextAction,
                  },
                ]}
              />
              {retained && !loading ? (
                <CatalogIntegrationCommandActionProvider actionPath={actionHref}>
                  <ImportJobLifecycleActions readModel={readModel} job={retained} />
                </CatalogIntegrationCommandActionProvider>
              ) : null}
            </WorkbenchStack>
          );
        })}
      </WorkbenchStack>
    </WorkflowModule>
  );
}
