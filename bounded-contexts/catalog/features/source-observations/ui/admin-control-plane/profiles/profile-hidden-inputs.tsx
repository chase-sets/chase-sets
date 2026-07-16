import { HiddenInput } from "@chase-sets/design-system";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import type { ProfileAuthoringReadModel, ProfileSectionWorkspace } from "./profile-formatting";

export function ProfileAuthoringHiddenInputs({
  readModel,
  authoring,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  authoring: ProfileAuthoringReadModel;
}) {
  const context = readModel.routeContext;
  const cloneDraft = authoring.cloneDraft;

  return (
    <>
      <HiddenInput name="_intent" value="provider-profile.clone" />
      <HiddenInput name="providerKey" value={cloneDraft.sourceProviderKey ?? context.providerKey ?? ""} />
      <HiddenInput name="unitKey" value={context.unitKey ?? ""} />
      <HiddenInput name="importScope" value={context.importScope ?? ""} />
      <HiddenInput name="profileVersion" value={cloneDraft.sourceProfileVersion ?? context.profileVersion ?? ""} />
      <HiddenInput name="sourceProviderKey" value={cloneDraft.sourceProviderKey ?? ""} />
      <HiddenInput name="sourceProfileVersion" value={cloneDraft.sourceProfileVersion ?? ""} />
      <HiddenInput name="targetLifecycle" value={cloneDraft.targetLifecycle} />
      <HiddenInput name="selectedObservationIds" value={context.selectedObservationIds.join(",")} />
      <HiddenInput name="jobId" value={context.jobId ?? ""} />
      <HiddenInput name="promotionPreviewId" value={context.promotionPreviewId ?? ""} />
    </>
  );
}

export function ProfileSectionHiddenInputs({
  readModel,
  workspace,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  workspace: ProfileSectionWorkspace;
}) {
  const context = readModel.routeContext;
  const selectedProfile = readModel.profileAuthoring.selectedProfile;

  return (
    <>
      <HiddenInput name="_intent" value="provider-profile.edit-section" />
      <HiddenInput name="sectionKey" value={workspace.sectionKey} />
      <HiddenInput name="providerKey" value={selectedProfile?.providerKey ?? context.providerKey ?? ""} />
      <HiddenInput name="unitKey" value={context.unitKey ?? ""} />
      <HiddenInput name="importScope" value={context.importScope ?? ""} />
      <HiddenInput name="profileVersion" value={selectedProfile?.profileVersion ?? context.profileVersion ?? ""} />
      <HiddenInput name="selectedObservationIds" value={context.selectedObservationIds.join(",")} />
      <HiddenInput name="jobId" value={context.jobId ?? ""} />
      <HiddenInput name="promotionPreviewId" value={context.promotionPreviewId ?? ""} />
    </>
  );
}
