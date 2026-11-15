import { Button, WorkbenchActionRow, WorkbenchForm } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { useCatalogIntegrationCommandHref } from "../import-to-promotion/command-action-context";
import { CommandHiddenInputs } from "../import-to-promotion/command-controls";

type ImportJob = CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number];

export function ImportJobLifecycleActions({
  readModel,
  job,
}: Readonly<{ readModel: CatalogPrimaryWorkbenchReadModel; job: ImportJob }>) {
  const context = {
    ...readModel.routeContext,
    providerKey: job.providerKey,
    unitKey: job.unitKey,
    importScope: job.importScope,
    jobId: job.jobId,
  };
  const actionHref = useCatalogIntegrationCommandHref(context);
  const jobReadModel = { ...readModel, routeContext: context };
  const disabled = !readModel.readiness.rbacAllowed;

  return (
    <WorkbenchActionRow>
      {(
        [
          [
            "job.retry",
            job.retryAvailable,
            "secondary",
            "catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.retry",
          ],
          [
            "job.resume",
            job.resumeAvailable,
            "secondary",
            "catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.resume",
          ],
          [
            "job.cancel",
            job.cancelAvailable,
            "danger",
            "catalog.features.sourceObservations.ui.primaryWorkbench.import.jobs.cancel",
          ],
        ] as const
      ).map(([intent, eligible, tone, labelKey]) =>
        eligible ? (
          <WorkbenchForm
            key={intent}
            variant="button"
            method="post"
            action={actionHref}
            data-catalog-primary-workbench-command={intent}
          >
            <CommandHiddenInputs readModel={jobReadModel} intent={intent} jobId={job.jobId} />
            <Button type="submit" size="sm" tone={tone} disabled={disabled}>
              {t(labelKey)}
            </Button>
          </WorkbenchForm>
        ) : null,
      )}
    </WorkbenchActionRow>
  );
}
