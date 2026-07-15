import { Button, HiddenInput, WorkbenchForm, type ButtonProps } from "@chase-sets/design-system";
import type {
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import { useCatalogIntegrationCommandHref } from "./command-action-context";

export type CatalogPrimaryWorkbenchSubmitIntent = Extract<
  CatalogPrimaryWorkbenchActionReadModel["key"],
  | "start-catalog-sync"
  | "start-provider-import"
  | "retry-import-job"
  | "resume-import-job"
  | "cancel-import-job"
  | "preview-promotion"
  | "execute-promotion"
  | "reject-source-observations"
  | "defer-source-observations"
  | "promote-merge-candidate"
  | "split-merge-candidate"
  | "update-merge-candidate"
  | "ignore-merge-candidate"
  | "defer-merge-candidate"
  | "rollback-provider-profile"
  | "deprecate-provider-profile"
  | "retire-provider-profile"
  | "start-reapply"
  | "start-replay"
>;

type CommandFormButtonProps = Omit<ButtonProps, "type" | "disabled"> & {
  readModel: CatalogPrimaryWorkbenchReadModel;
  intent: CatalogPrimaryWorkbenchSubmitIntent;
  selectedObservationIds?: readonly string[];
  candidateId?: string;
  reason?: string;
  mergeCandidateCommandBody?: string;
  disabled?: boolean;
};

export function CommandFormButton({
  readModel,
  intent,
  selectedObservationIds,
  candidateId,
  reason,
  mergeCandidateCommandBody,
  disabled = false,
  children,
  ...buttonProps
}: CommandFormButtonProps) {
  const actionHref = useCatalogIntegrationCommandHref(readModel.routeContext);

  return (
    <WorkbenchForm variant="button" method="post" action={actionHref} data-catalog-primary-workbench-command={intent}>
      <CommandHiddenInputs
        readModel={readModel}
        intent={intent}
        selectedObservationIds={selectedObservationIds}
        candidateId={candidateId}
        mergeCandidateCommandBody={mergeCandidateCommandBody}
      />
      {reason ? <HiddenInput name="reason" value={reason} /> : null}
      <Button type="submit" disabled={disabled || !isActionAvailable(readModel, intent)} {...buttonProps}>
        {children}
      </Button>
    </WorkbenchForm>
  );
}

export function CommandHiddenInputs({
  readModel,
  intent,
  selectedObservationIds,
  candidateId,
  jobId,
  mergeCandidateCommandBody,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  intent: CatalogPrimaryWorkbenchSubmitIntent;
  selectedObservationIds?: readonly string[];
  candidateId?: string;
  jobId?: string | null;
  mergeCandidateCommandBody?: string;
}) {
  const context = readModel.routeContext;
  const scope = context.scope;
  const observationIds = selectedObservationIds ?? context.selectedObservationIds;
  const jobIdValue = jobId ?? context.jobId ?? "";

  return (
    <>
      <HiddenInput name="_intent" value={intent} />
      <HiddenInput name="providerKey" value={context.providerKey ?? ""} />
      <HiddenInput name="unitKey" value={context.unitKey ?? ""} />
      <HiddenInput name="importScope" value={context.importScope ?? ""} />
      <HiddenInput name="profileVersion" value={context.profileVersion ?? ""} />
      <HiddenInput name="languageCode" value={scope?.languageCode ?? ""} />
      <HiddenInput name="productLineId" value={scope?.productLineId ?? ""} />
      <HiddenInput name="productLineName" value={scope?.productLineName ?? ""} />
      <HiddenInput name="seriesId" value={scope?.seriesId ?? ""} />
      <HiddenInput name="seriesName" value={scope?.seriesName ?? ""} />
      <HiddenInput name="expansionId" value={scope?.expansionId ?? ""} />
      <HiddenInput name="expansionName" value={scope?.expansionName ?? ""} />
      <HiddenInput name="selectedObservationIds" value={observationIds.join(",")} />
      <HiddenInput name="candidateId" value={candidateId ?? ""} />
      <HiddenInput name="mergeCandidateCommandBody" value={mergeCandidateCommandBody ?? ""} />
      <HiddenInput name="jobId" value={jobIdValue} />
      <HiddenInput name="promotionPreviewId" value={context.promotionPreviewId ?? ""} />
      <HiddenInput name="scopeRecordId" value={context.scopeRecordId ?? ""} />
    </>
  );
}

export function isActionAvailable(
  readModel: CatalogPrimaryWorkbenchReadModel,
  key: CatalogPrimaryWorkbenchActionReadModel["key"],
): boolean {
  const state = actionState(readModel, key);
  return state === "available" || state === "degraded";
}

export function actionState(
  readModel: CatalogPrimaryWorkbenchReadModel,
  key: CatalogPrimaryWorkbenchActionReadModel["key"],
) {
  return readModel.actions.find((action) => action.key === key)?.state ?? "unavailable";
}

export function actionBlockers(
  readModel: CatalogPrimaryWorkbenchReadModel,
  key: CatalogPrimaryWorkbenchActionReadModel["key"],
) {
  return readModel.actions.find((action) => action.key === key)?.blockers ?? ["unsupported-command"];
}
