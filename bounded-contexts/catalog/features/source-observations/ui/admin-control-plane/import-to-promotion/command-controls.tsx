import { Button, HiddenInput, WorkbenchForm, type ButtonProps } from "@chase-sets/design-system";
import type {
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import { catalogPrimaryWorkbenchHref } from "../../primary-workbench-route-context";

export type CatalogPrimaryWorkbenchSubmitIntent = Extract<
  CatalogPrimaryWorkbenchActionReadModel["key"],
  | "start-provider-import"
  | "retry-import-job"
  | "resume-import-job"
  | "cancel-import-job"
  | "preview-promotion"
  | "execute-promotion"
  | "reject-source-observations"
  | "defer-source-observations"
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
  reason?: string;
  disabled?: boolean;
};

export function CommandFormButton({
  readModel,
  intent,
  selectedObservationIds,
  reason,
  disabled = false,
  children,
  ...buttonProps
}: CommandFormButtonProps) {
  return (
    <WorkbenchForm
      variant="button"
      method="post"
      action={catalogPrimaryWorkbenchHref(readModel.routeContext, "import-to-promotion")}
      data-catalog-primary-workbench-command={intent}
    >
      <CommandHiddenInputs readModel={readModel} intent={intent} selectedObservationIds={selectedObservationIds} />
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
  jobId,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  intent: CatalogPrimaryWorkbenchSubmitIntent;
  selectedObservationIds?: readonly string[];
  jobId?: string | null;
}) {
  const context = readModel.routeContext;
  const observationIds = selectedObservationIds ?? context.selectedObservationIds;
  const jobIdValue = jobId ?? context.jobId ?? "";

  return (
    <>
      <HiddenInput name="_intent" value={intent} />
      <HiddenInput name="providerKey" value={context.providerKey ?? ""} />
      <HiddenInput name="unitKey" value={context.unitKey ?? ""} />
      <HiddenInput name="importScope" value={context.importScope ?? ""} />
      <HiddenInput name="profileVersion" value={context.profileVersion ?? ""} />
      <HiddenInput name="selectedObservationIds" value={observationIds.join(",")} />
      <HiddenInput name="jobId" value={jobIdValue} />
      <HiddenInput name="promotionPreviewId" value={context.promotionPreviewId ?? ""} />
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
